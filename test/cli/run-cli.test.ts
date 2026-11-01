import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run-cli.ts';

const fixturesDirectory = fileURLToPath(
  new URL('../fixtures/', import.meta.url),
);
const esmProjectDirectory = path.join(fixturesDirectory, 'esm-nest-project');
const cjsProjectDirectory = path.join(fixturesDirectory, 'cjs-nest-project');
const casesDirectory = path.join(fixturesDirectory, 'loader-cases');
const esmEnvPassword = 'fixture-password-esm-7f3a91';
const cjsEnvPassword = 'fixture-password-cjs-4c82d0';

type CliRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly openedUrls: readonly string[];
};

async function runCliInDirectory(
  cwd: string,
  argv: readonly string[],
  overrides: {
    readonly shellEnv?: Readonly<Record<string, string>>;
    readonly nodeVersion?: string;
    readonly stopSignal?: AbortSignal;
    readonly onStdout?: (text: string) => void;
    readonly isTTY?: boolean;
  } = {},
): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const openedUrls: string[] = [];
  const exitCode = await runCli({
    argv,
    cwd,
    shellEnv: overrides.shellEnv ?? {},
    nodeVersion: overrides.nodeVersion ?? process.versions.node,
    stopSignal: overrides.stopSignal ?? new AbortController().signal,
    stdout: {
      isTTY: overrides.isTTY ?? false,
      write: (text: string): void => {
        stdout += text;
        overrides.onStdout?.(text);
      },
    },
    stderr: {
      write: (text: string): void => {
        stderr += text;
      },
    },
    openBrowser: (url: string): void => {
      openedUrls.push(url);
    },
  });
  return { exitCode, stdout, stderr, openedUrls };
}

const studioStartTimeoutMs = 20_000;

async function runStudioUntilStopLine(
  cwd: string,
  argv: readonly string[],
  shellEnv: Readonly<Record<string, string>>,
  isTTY = false,
): Promise<CliRun> {
  const stopController = new AbortController();
  const safetyTimer = setTimeout(
    () => stopController.abort(),
    studioStartTimeoutMs,
  );
  try {
    return await runCliInDirectory(cwd, argv, {
      shellEnv,
      isTTY,
      stopSignal: stopController.signal,
      onStdout: (text: string): void => {
        if (text.includes('Ctrl-C to stop')) stopController.abort();
      },
    });
  } finally {
    clearTimeout(safetyTimer);
  }
}

async function reserveClosedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== 'object' || address === null) {
    throw new Error('the throwaway server has no port');
  }
  return address.port;
}

describe('runCli without a database', () => {
  it('prints the help and exits 0', async () => {
    const run = await runCliInDirectory(esmProjectDirectory, ['--help']);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/^Usage: typeorm-studio/);
  });

  it('prints the package version and exits 0', async () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { readonly version: string };
    const run = await runCliInDirectory(esmProjectDirectory, ['-v']);

    expect(run).toEqual({
      exitCode: 0,
      stdout: `${packageJson.version}\n`,
      stderr: '',
      openedUrls: [],
    });
  });

  it('exits 2 on Node older than 22.15 and accepts 22.15', async () => {
    const tooOld = await runCliInDirectory(esmProjectDirectory, ['--help'], {
      nodeVersion: '22.14.0',
    });
    const oldestSupported = await runCliInDirectory(
      esmProjectDirectory,
      ['--help'],
      { nodeVersion: '22.15.0' },
    );

    expect(tooOld.exitCode).toBe(2);
    expect(tooOld.stderr).toContain(
      'typeorm-studio needs Node >= 22.15, found 22.14.0',
    );
    expect(oldestSupported.exitCode).toBe(0);
  });

  it.each([
    { argv: ['--nope'], message: "Unknown option '--nope'" },
    {
      argv: ['one', 'two'],
      message: 'Expected at most one project directory, got 2: one two',
    },
    {
      argv: ['--port', '0'],
      message: '--port must be an integer from 1 to 65535, got "0"',
    },
    {
      argv: ['--port', 'abc'],
      message: '--port must be an integer from 1 to 65535, got "abc"',
    },
  ])('exits 2 on usage error $argv', async ({ argv, message }) => {
    const run = await runCliInDirectory(esmProjectDirectory, argv);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(message);
  });

  it.each([
    {
      argv: ['-d', 'missing.ts', '--dry-run'],
      message: 'DataSource file not found: missing.ts',
    },
    {
      argv: ['--env-file', 'missing.env', '--dry-run'],
      message: 'Env file not found or unreadable: missing.env',
    },
  ])('exits 3 on $argv', async ({ argv, message }) => {
    const run = await runCliInDirectory(esmProjectDirectory, argv);

    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain(message);
  });

  it('exits 3 when a project has no DataSource file', async () => {
    const projectDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'typeorm-studio-cli-'),
    );
    fs.writeFileSync(
      path.join(projectDirectory, 'package.json'),
      '{"name":"project-without-datasource"}',
    );
    try {
      const run = await runCliInDirectory(projectDirectory, ['--dry-run']);

      expect(run.exitCode).toBe(3);
      expect(run.stderr).toContain('No TypeORM DataSource file found');
    } finally {
      fs.rmSync(projectDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      caseName: 'no-datasource-export',
      exitCode: 4,
      message:
        'datasource.js exports no DataSource (exports: helper, helperName)',
    },
    {
      caseName: 'process-exit',
      exitCode: 4,
      message: 'datasource.js called process.exit(1) while loading',
    },
    {
      caseName: 'non-postgres',
      exitCode: 5,
      message: 'TypeORM type "mysql" is not supported yet',
    },
  ])(
    'exits $exitCode when loading the $caseName case fails',
    async ({ caseName, exitCode, message }) => {
      const run = await runCliInDirectory(path.join(casesDirectory, caseName), [
        '-d',
        'datasource.js',
        '--dry-run',
      ]);

      expect(run.exitCode).toBe(exitCode);
      expect(run.stderr).toContain(message);
      expect(run.stdout + run.stderr).not.toContain('case-password-mysql-1042');
    },
  );

  it('exits 6 on a closed port and never prints the password', async () => {
    const closedPort = await reserveClosedPort();

    const run = await runCliInDirectory(esmProjectDirectory, ['--dry-run'], {
      shellEnv: { POSTGRES_PORT: String(closedPort) },
    });

    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain(`127.0.0.1:${closedPort}`);
    expect(run.stderr).toContain('connection refused');
    expect(run.stdout + run.stderr).not.toContain(esmEnvPassword);
  });
});

describe('runCli against a real Postgres', () => {
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.6-alpine')
      .withDatabase('fixture_esm_db')
      .withUsername('fixture_user')
      .withPassword(esmEnvPassword)
      .start();
  });

  afterAll(async () => {
    await container?.stop();
  });

  it.each([
    {
      name: 'ESM Nest project',
      directory: esmProjectDirectory,
      datasourceFile: 'src/config/database/postgres.data-source.ts',
      pointAtContainer: (host: string, port: string) => ({
        POSTGRES_HOST: host,
        POSTGRES_PORT: port,
      }),
    },
    {
      name: 'CJS Nest project',
      directory: cjsProjectDirectory,
      datasourceFile: 'src/config/db/postgres/fixture-datasource.ts',
      pointAtContainer: (host: string, port: string) => ({
        FIXTURE_DB_HOST: host,
        FIXTURE_DB_PORT: port,
        FIXTURE_DB_NAME: 'fixture_esm_db',
        FIXTURE_DB_PASSWORD: esmEnvPassword,
      }),
    },
  ])(
    'dry-runs the $name read-only and never prints the password',
    async ({ directory, datasourceFile, pointAtContainer }) => {
      const run = await runCliInDirectory(directory, ['--dry-run'], {
        shellEnv: pointAtContainer(
          String(container?.getHost()),
          String(container?.getPort()),
        ),
      });

      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain(datasourceFile);
      expect(run.stdout).toContain('(credentials hidden)');
      expect(run.stdout).toContain('read-only (pass --write to edit)');
      expect(run.stdout).toMatch(/check {7}reachable in \d+ ms/);
      expect(run.stdout).toContain('done, Studio not started');
      expect(run.stdout + run.stderr).not.toContain(esmEnvPassword);
      expect(run.stdout + run.stderr).not.toContain(cjsEnvPassword);
    },
  );

  it('dry-runs read-write with --write', async () => {
    const run = await runCliInDirectory(
      esmProjectDirectory,
      ['--dry-run', '--write'],
      {
        shellEnv: {
          POSTGRES_HOST: String(container?.getHost()),
          POSTGRES_PORT: String(container?.getPort()),
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/mode {8}read-write\n/);
  });

  it('starts Studio read-only on an explicit port and stops on abort', async () => {
    const studioPort = await reserveClosedPort();

    const run = await runStudioUntilStopLine(
      esmProjectDirectory,
      ['--port', String(studioPort)],
      {
        POSTGRES_HOST: String(container?.getHost()),
        POSTGRES_PORT: String(container?.getPort()),
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      `  studio      https://local.drizzle.studio?port=${studioPort}\n`,
    );
    expect(run.stdout.split('https://local.drizzle.studio')).toHaveLength(2);
    expect(run.stdout).toContain('read-only (pass --write to edit)');
    expect(run.stdout).toContain('Ctrl-C to stop');
    expect(run.stdout).not.toContain('\u001B');
    expect(run.openedUrls).toEqual([
      `https://local.drizzle.studio?port=${studioPort}`,
    ]);
    expect(run.stdout + run.stderr).not.toContain(esmEnvPassword);
    expect(run.stdout + run.stderr).not.toContain(cjsEnvPassword);
  });

  it('prints the Studio URL as a clickable OSC 8 link in a terminal', async () => {
    const studioPort = await reserveClosedPort();
    const url = `https://local.drizzle.studio?port=${studioPort}`;

    const run = await runStudioUntilStopLine(
      esmProjectDirectory,
      ['--port', String(studioPort)],
      {
        POSTGRES_HOST: String(container?.getHost()),
        POSTGRES_PORT: String(container?.getPort()),
      },
      true,
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      `  studio      \u001B]8;;${url}\u001B\\${url}\u001B]8;;\u001B\\\n`,
    );
  });

  it('does not open the browser with --no-open', async () => {
    const studioPort = await reserveClosedPort();

    const run = await runStudioUntilStopLine(
      esmProjectDirectory,
      ['--no-open', '--port', String(studioPort)],
      {
        POSTGRES_HOST: String(container?.getHost()),
        POSTGRES_PORT: String(container?.getPort()),
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.openedUrls).toEqual([]);
    expect(run.stdout).toContain(
      'open it in your browser; press Ctrl-C to stop',
    );
  });

  it('starts Studio read-write with --write and stops on abort', async () => {
    const studioPort = await reserveClosedPort();

    const run = await runStudioUntilStopLine(
      esmProjectDirectory,
      ['--write', '--port', String(studioPort)],
      {
        POSTGRES_HOST: String(container?.getHost()),
        POSTGRES_PORT: String(container?.getPort()),
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/mode {8}read-write\n/);
    expect(run.stdout).toContain('https://local.drizzle.studio');
    expect(run.stdout + run.stderr).not.toContain(esmEnvPassword);
  });

  it('exits 7 when the explicit --port is already in use', async () => {
    const occupant = net.createServer();
    await new Promise<void>((resolve) =>
      occupant.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = occupant.address();
      if (typeof address !== 'object' || address === null) {
        throw new Error('the occupying server has no port');
      }

      const run = await runStudioUntilStopLine(
        esmProjectDirectory,
        ['--port', String(address.port)],
        {
          POSTGRES_HOST: String(container?.getHost()),
          POSTGRES_PORT: String(container?.getPort()),
        },
      );

      expect(run.exitCode).toBe(7);
      expect(run.stderr).toContain(
        `Port ${address.port} on 127.0.0.1 is already in use`,
      );
      expect(run.stdout).not.toContain('https://local.drizzle.studio');
      expect(run.stdout + run.stderr).not.toContain(esmEnvPassword);
    } finally {
      await new Promise<void>((resolve) => occupant.close(() => resolve()));
    }
  });

  it('exits 6 on a wrong password and prints neither password', async () => {
    const wrongPassword = 'wrong-password-sentinel-3b9f';

    const run = await runCliInDirectory(esmProjectDirectory, ['--dry-run'], {
      shellEnv: {
        POSTGRES_HOST: String(container?.getHost()),
        POSTGRES_PORT: String(container?.getPort()),
        POSTGRES_PASSWORD: wrongPassword,
      },
    });

    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain('authentication failed');
    expect(run.stdout + run.stderr).not.toContain(wrongPassword);
    expect(run.stdout + run.stderr).not.toContain(esmEnvPassword);
  });
});
