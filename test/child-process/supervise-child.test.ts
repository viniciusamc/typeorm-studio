import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runChildForOneMessage } from '../../src/child-process/supervise-child.ts';
import type {
  ChildSpec,
  OneMessageOutcome,
} from '../../src/child-process/supervise-child.ts';

const childReportSchema = z.object({
  kind: z.literal('report'),
  pid: z.number().int().positive(),
  cwd: z.string(),
  envKeys: z.array(z.string()),
  argv: z.array(z.string()),
  execArgv: z.array(z.string()),
});

type ChildReport = z.infer<typeof childReportSchema>;

function isChildReport(value: unknown): value is ChildReport {
  return childReportSchema.safeParse(value).success;
}

const childrenDirectory = fileURLToPath(
  new URL('./children/', import.meta.url),
);
let workingDirectory = '';

beforeAll(() => {
  workingDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'typeorm-studio-')),
  );
});

afterAll(() => {
  fs.rmSync(workingDirectory, { recursive: true, force: true });
});

function buildChildSpec(
  entryName: string,
  overrides: Partial<ChildSpec> = {},
): ChildSpec {
  return {
    label: `test child ${entryName}`,
    entry: path.join(childrenDirectory, entryName),
    entryArguments: [],
    nodeArguments: [],
    cwd: workingDirectory,
    environment: {},
    ...overrides,
  };
}

function superviseTestChild(
  entryName: string,
  timeoutMs: number,
  overrides: Partial<ChildSpec> = {},
): Promise<OneMessageOutcome<ChildReport>> {
  return runChildForOneMessage(buildChildSpec(entryName, overrides), {
    timeoutMs,
    isExpectedMessage: isChildReport,
  });
}

function requireReport(outcome: OneMessageOutcome<ChildReport>): ChildReport {
  if (outcome.kind !== 'message') {
    throw new Error(
      `expected a message outcome, got ${JSON.stringify(outcome)}`,
    );
  }
  return outcome.message;
}

function probePid(pid: number): string {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error instanceof Error && 'code' in error
      ? String(error.code)
      : 'unknown';
  }
}

function readLabeledPid(outputTail: string, label: string): number {
  const match = new RegExp(`^${label}:(\\d+)$`, 'm').exec(outputTail);
  if (match === null) {
    throw new Error(
      `no "${label}:<pid>" line in the output tail ${JSON.stringify(outputTail)}`,
    );
  }
  return Number(match[1]);
}

function killLeftoverProcess(pid: number): void {
  if (probePid(pid) === 'ESRCH') return;
  process.kill(pid, 'SIGKILL');
}

async function captureRejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error rejection, got ${String(error)}`);
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('runChildForOneMessage', () => {
  it('returns the expected message after ignoring junk and leaves no process behind', async () => {
    const offered: unknown[] = [];
    const outcome = await runChildForOneMessage(
      buildChildSpec('send-junk-then-report.mjs'),
      {
        timeoutMs: 10_000,
        isExpectedMessage: (value: unknown): value is ChildReport => {
          offered.push(value);
          return isChildReport(value);
        },
      },
    );

    const report = requireReport(outcome);
    expect(offered.slice(0, 3)).toEqual([
      'junk string',
      null,
      { kind: 'report' },
    ]);
    expect(outcome.outputTail).toContain(`pid:${report.pid}`);
    expect(probePid(report.pid)).toBe('ESRCH');
  });

  it('reports an exit with code 3 together with the combined stdout and stderr text', async () => {
    const outcome = await superviseTestChild('exit-with-stderr.mjs', 10_000);

    expect(outcome).toMatchObject({
      kind: 'exited-without-message',
      exitCode: 3,
      signal: null,
    });
    expect(outcome.outputTail).toContain('stdout line before failing');
    expect(outcome.outputTail).toContain(
      'Error: boom while loading the data source',
    );
  });

  it('reports a death by signal with a null exit code', async () => {
    const outcome = await superviseTestChild('die-by-signal.mjs', 10_000);

    expect(outcome).toMatchObject({
      kind: 'exited-without-message',
      exitCode: null,
      signal: 'SIGKILL',
    });
  });

  it.each([1, 2, 3, 4, 5])(
    'still returns the message when the child exits right after sending it (run %i)',
    async () => {
      const report = requireReport(
        await superviseTestChild('send-report-and-exit.mjs', 10_000),
      );

      expect(probePid(report.pid)).toBe('ESRCH');
    },
  );

  it('times out a hung child within the timeout plus the kill grace and leaves no process behind', async () => {
    const timeoutMs = 1_500;
    const startedAt = performance.now();
    const outcome = await superviseTestChild('hang.mjs', timeoutMs);
    const elapsedMs = performance.now() - startedAt;

    expect(outcome.kind).toBe('timed-out');
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(elapsedMs).toBeLessThan(timeoutMs + 1_500);
    expect(probePid(readLabeledPid(outcome.outputTail, 'pid'))).toBe('ESRCH');
  });

  it('stops a child that ignores the disconnect with SIGTERM, without waiting for the grace', async () => {
    const startedAt = performance.now();
    const report = requireReport(
      await superviseTestChild('hang.mjs', 10_000, {
        entryArguments: ['send-report'],
      }),
    );
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_900);
    expect(probePid(report.pid)).toBe('ESRCH');
  });

  it('disconnects the child after its message, so one that ignores SIGTERM can still leave before the grace', async () => {
    const startedAt = performance.now();
    const report = requireReport(
      await superviseTestChild('hang.mjs', 10_000, {
        entryArguments: ['send-report', 'ignore-sigterm', 'exit-on-disconnect'],
      }),
    );
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_900);
    expect(probePid(report.pid)).toBe('ESRCH');
  });

  it('disconnects the child on timeout, so one that ignores SIGTERM can still leave before the grace', async () => {
    const timeoutMs = 1_500;
    const startedAt = performance.now();
    const outcome = await superviseTestChild('hang.mjs', timeoutMs, {
      entryArguments: ['ignore-sigterm', 'exit-on-disconnect'],
    });
    const elapsedMs = performance.now() - startedAt;

    expect(outcome.kind).toBe('timed-out');
    expect(elapsedMs).toBeLessThan(timeoutMs + 1_500);
    expect(probePid(readLabeledPid(outcome.outputTail, 'pid'))).toBe('ESRCH');
  });

  it('escalates to SIGKILL after the 2 s grace when the child ignores SIGTERM after its message, even if the timeout elapses meanwhile', async () => {
    const startedAt = performance.now();
    const outcome = await superviseTestChild('hang.mjs', 1_500, {
      entryArguments: ['send-report', 'ignore-sigterm'],
    });
    const elapsedMs = performance.now() - startedAt;

    const report = requireReport(outcome);
    expect(outcome.outputTail).toContain('sigterm-ignored');
    expect(elapsedMs).toBeGreaterThanOrEqual(2_000 - 50);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(probePid(report.pid)).toBe('ESRCH');
  });

  it('escalates to SIGKILL after the 2 s grace when a timed-out child ignores SIGTERM', async () => {
    const timeoutMs = 2_000;
    const startedAt = performance.now();
    const outcome = await superviseTestChild('hang.mjs', timeoutMs, {
      entryArguments: ['ignore-sigterm'],
    });
    const elapsedMs = performance.now() - startedAt;

    expect(outcome.kind).toBe('timed-out');
    expect(outcome.outputTail).toContain('sigterm-ignored');
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs + 2_000 - 50);
    expect(elapsedMs).toBeLessThan(timeoutMs + 2_000 + 1_500);
    expect(probePid(readLabeledPid(outcome.outputTail, 'pid'))).toBe('ESRCH');
  });

  it('keeps only the last 64 KiB of the output', async () => {
    const outcome = await superviseTestChild('flood-ascii-output.mjs', 10_000);

    expect(outcome).toMatchObject({
      kind: 'exited-without-message',
      exitCode: 0,
    });
    expect(Buffer.byteLength(outcome.outputTail)).toBe(64 * 1024);
    expect(outcome.outputTail.endsWith(`line-003999${'x'.repeat(88)}\n`)).toBe(
      true,
    );
    expect(outcome.outputTail).toContain('line-003400');
    expect(outcome.outputTail).not.toContain('line-003300');
  });

  it('starts the output tail on a character boundary', async () => {
    const outcome = await superviseTestChild(
      'flood-multibyte-output.mjs',
      10_000,
    );

    expect(outcome.outputTail).not.toContain(String.fromCodePoint(0xfffd));
    expect(outcome.outputTail.startsWith('é')).toBe(true);
    expect(outcome.outputTail.endsWith('éy')).toBe(true);
    expect(Buffer.byteLength(outcome.outputTail)).toBeLessThanOrEqual(
      64 * 1024,
    );
  });

  it('gives the child exactly the given environment and nothing inherited', async () => {
    const report = requireReport(
      await superviseTestChild('send-junk-then-report.mjs', 10_000, {
        environment: {
          TYPEORM_STUDIO_FIRST: 'one',
          TYPEORM_STUDIO_SECOND: 'two',
        },
      }),
    );

    expect(report.envKeys).toEqual([
      'TYPEORM_STUDIO_FIRST',
      'TYPEORM_STUDIO_SECOND',
    ]);
  });

  it('runs the child in the given cwd', async () => {
    const report = requireReport(
      await superviseTestChild('send-junk-then-report.mjs', 10_000),
    );

    expect(report.cwd).toBe(workingDirectory);
  });

  it('passes entry arguments after the entry and node arguments before it', async () => {
    const report = requireReport(
      await superviseTestChild('send-junk-then-report.mjs', 10_000, {
        entryArguments: ['alpha', 'beta gamma'],
        nodeArguments: ['--enable-source-maps'],
      }),
    );

    expect(report.argv).toEqual(['alpha', 'beta gamma']);
    expect(report.execArgv).toEqual(['--enable-source-maps']);
  });

  it('keeps collecting output after the child exits but stops waiting on a grandchild that keeps the pipes open', async () => {
    const startedAt = performance.now();
    const outcome = await superviseTestChild(
      'spawn-grandchild-then-report.mjs',
      10_000,
    );
    const elapsedMs = performance.now() - startedAt;

    const grandchildPid = readLabeledPid(outcome.outputTail, 'grandchild');
    try {
      const report = requireReport(outcome);
      expect(outcome.outputTail).toContain('late grandchild line');
      expect(elapsedMs).toBeLessThan(3_000);
      expect(probePid(report.pid)).toBe('ESRCH');
    } finally {
      killLeftoverProcess(grandchildPid);
    }
  });

  it('leaves no timer, process or pipe handle active once every outcome has settled', async () => {
    // The host imports the .ts source; Node 22.6 to 22.17 strips types only behind the flag.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(childrenDirectory, 'supervise-and-list-resources.mjs'),
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );

    const summary = z
      .object({
        outcomeKinds: z.array(z.string()),
        resourcesBefore: z.array(z.string()),
        resourcesAfter: z.array(z.string()),
      })
      .parse(JSON.parse(stdout));
    expect(summary.outcomeKinds).toEqual([
      'message',
      'exited-without-message',
      'timed-out',
      'rejected',
    ]);
    expect(summary.resourcesAfter).toEqual(summary.resourcesBefore);
  });

  it('rejects with a message naming the label, the cwd and the error code when the cwd does not exist', async () => {
    const missingDirectory = path.join(workingDirectory, 'does-not-exist');

    const failure = await captureRejection(
      superviseTestChild('send-junk-then-report.mjs', 10_000, {
        cwd: missingDirectory,
        environment: { SENTINEL_KEY: 'sentinel-value' },
      }),
    );

    expect(failure.message).toContain('test child send-junk-then-report.mjs');
    expect(failure.message).toContain(missingDirectory);
    expect(failure.message).toContain('ENOENT');
    expect(failure.message).not.toContain('sentinel');
  });

  it('rejects without echoing the environment value when node refuses it', async () => {
    const failure = await captureRejection(
      superviseTestChild('send-junk-then-report.mjs', 10_000, {
        environment: { SENTINEL_KEY: 'sentinel\u0000value' },
      }),
    );

    expect(failure.message).toContain('ERR_INVALID_ARG_VALUE');
    expect(failure.message).not.toContain('sentinel');
  });
});
