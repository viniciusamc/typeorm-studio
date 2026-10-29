import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export type ChildSpec = {
  readonly label: string;
  readonly entry: string;
  readonly entryArguments: readonly string[];
  readonly nodeArguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
};

export type OneMessageOutcome<Message> =
  | {
      readonly kind: 'message';
      readonly message: Message;
      readonly outputTail: string;
    }
  | {
      readonly kind: 'exited-without-message';
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly outputTail: string;
    }
  | { readonly kind: 'timed-out'; readonly outputTail: string };

// The entry must exit by itself when its IPC channel disconnects: that is the only
// cleanup left if this process is SIGKILLed. Otherwise the promise settles only after
// the child has exited, so nothing outlives the call.
export async function runChildForOneMessage<Message>(
  spec: ChildSpec,
  options: {
    readonly timeoutMs: number;
    readonly isExpectedMessage: (value: unknown) => value is Message;
  },
): Promise<OneMessageOutcome<Message>> {
  return new Promise<OneMessageOutcome<Message>>((resolve, reject) => {
    const child = startNodeProcess(spec);
    let outputTail = Buffer.alloc(0);
    let verdict:
      | { readonly kind: 'message'; readonly message: Message }
      | { readonly kind: 'timed-out' }
      | undefined;
    let observedExitCode: number | null = null;
    let observedSignal: string | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let isSettled = false;

    const releaseChild = (): void => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.connected) child.disconnect();
    };

    const settleOutcome = (): void => {
      if (isSettled) return;
      isSettled = true;
      releaseChild();
      const tail = decodeOutputTail(outputTail);
      if (verdict !== undefined) {
        resolve({ ...verdict, outputTail: tail });
        return;
      }
      resolve({
        kind: 'exited-without-message',
        exitCode: observedExitCode,
        signal: observedSignal,
        outputTail: tail,
      });
    };

    // Node never emits the child's 'close' once disconnect() was called from this side
    // (it stops counting the IPC channel), so exit, stdout, stderr and IPC are awaited
    // one by one instead.
    let openParts = 4;
    const markPartClosed = (): void => {
      openParts -= 1;
      if (openParts === 0) settleOutcome();
    };

    const terminateChild = (): void => {
      clearTimeout(timeoutTimer);
      if (child.connected) child.disconnect();
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    };

    const timeoutTimer = setTimeout(() => {
      verdict = { kind: 'timed-out' };
      terminateChild();
    }, options.timeoutMs);

    const collectOutputChunk = (chunk: Buffer): void => {
      outputTail = Buffer.concat([outputTail, chunk]).subarray(-64 * 1024);
    };
    child.stdout?.on('data', collectOutputChunk);
    child.stderr?.on('data', collectOutputChunk);
    child.stdout?.once('close', markPartClosed);
    child.stderr?.once('close', markPartClosed);
    child.once('disconnect', markPartClosed);

    child.on('message', (value: unknown) => {
      if (verdict !== undefined || !options.isExpectedMessage(value)) return;
      verdict = { kind: 'message', message: value };
      terminateChild();
    });

    child.once('exit', (exitCode, signal) => {
      observedExitCode = exitCode;
      observedSignal = signal;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      // A grandchild that inherited stdout or stderr keeps them open after the
      // child is gone, so the wait for them is bounded.
      drainTimer = setTimeout(settleOutcome, 1_000);
      markPartClosed();
    });

    child.once('error', (error) => {
      releaseChild();
      reject(describeStartFailure(spec, error));
    });
  });
}

function startNodeProcess(spec: ChildSpec): ChildProcess {
  try {
    return spawn(
      process.execPath,
      [...spec.nodeArguments, spec.entry, ...spec.entryArguments],
      {
        cwd: spec.cwd,
        env: spec.environment,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
  } catch (error) {
    throw describeStartFailure(spec, error);
  }
}

// Only the error code is kept: Node's own message for a bad argument or environment
// entry echoes the offending value, and environment values can be secrets.
function describeStartFailure(spec: ChildSpec, error: unknown): Error {
  const code =
    error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
  return new Error(
    `${spec.label}: node did not start (error code ${code}); expected cwd "${spec.cwd}" to be an existing directory and no NUL byte in the arguments or environment`,
  );
}

function decodeOutputTail(bytes: Buffer): string {
  // The byte-wise cut can land inside a UTF-8 sequence; drop its continuation bytes so
  // the text starts on a character and never grows past the byte limit.
  let start = 0;
  while (
    start < 3 &&
    start < bytes.length &&
    (bytes[start] & 0b1100_0000) === 0b1000_0000
  ) {
    start += 1;
  }
  return bytes.toString('utf8', start);
}
