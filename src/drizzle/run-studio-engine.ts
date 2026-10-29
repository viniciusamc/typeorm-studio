import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type StudioDatabase = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string | undefined;
  readonly database: string;
  readonly tls:
    | false
    | {
        readonly rejectUnauthorized: boolean;
        readonly ca?: string;
        readonly cert?: string;
        readonly key?: string;
        readonly passphrase?: string;
        readonly servername?: string;
      };
  readonly startupOptions: string | undefined;
};

export type StudioEngineExit =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'port-busy'; readonly port: number }
  | {
      readonly kind: 'pins-mismatch';
      readonly packageName: string;
      readonly expected: string;
      readonly found: string;
    }
  | { readonly kind: 'gate-refused'; readonly outputTail: string }
  | {
      readonly kind: 'engine-failed';
      readonly phase: 'starting' | 'running';
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly outputTail: string;
    };

type StudioEngineRequest = {
  readonly database: StudioDatabase;
  readonly port: number | undefined;
  readonly abortSignal: AbortSignal;
  readonly onListening: (studio: {
    readonly url: string;
    readonly port: number;
    readonly enginePid: number;
  }) => void;
};

type EngineEvent =
  | { readonly kind: 'listening'; readonly port: number }
  | { readonly kind: 'listen-failed'; readonly code: string | undefined }
  | { readonly kind: 'gate-refused' };

// The hosted UI accepts only some engine protocol versions, and drizzle-kit
// needs a matching drizzle-orm beside it, so the pair moves together on purpose.
const pinnedVersions: Readonly<Record<string, string>> = {
  'drizzle-kit': '0.31.11',
  'drizzle-orm': '0.45.4',
};
const studioUrl = 'https://local.drizzle.studio';
const defaultPort = 4983;
const engineChannel = 'typeorm-studio/engine';
const startTimeoutMs = 30_000;
const stopGraceMs = 2_000;
const outputTailLength = 8_000;
const engineDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function runStudioEngine(
  request: StudioEngineRequest,
): Promise<StudioEngineExit> {
  const pinMismatch = findPinMismatch();
  if (pinMismatch !== undefined) return pinMismatch;
  const port = await chooseEnginePort(request.port);
  if (port === undefined) {
    return { kind: 'port-busy', port: request.port ?? defaultPort };
  }
  return await superviseEngine(request, port);
}

function findPinMismatch():
  Extract<StudioEngineExit, { kind: 'pins-mismatch' }> | undefined {
  for (const [packageName, expected] of Object.entries(pinnedVersions)) {
    const found = readPackageManifest(packageName).version;
    if (found !== expected) {
      return { kind: 'pins-mismatch', packageName, expected, found };
    }
  }
  return undefined;
}

function readPackageManifest(packageName: string): {
  readonly version: string;
  readonly directory: string;
  readonly bin: unknown;
} {
  const manifestPath = findPackageJSON(packageName, import.meta.url);
  if (manifestPath === undefined) {
    return { version: 'not installed', directory: '', bin: undefined };
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const fields =
    typeof manifest === 'object' && manifest !== null ? manifest : {};
  return {
    version:
      'version' in fields && typeof fields.version === 'string'
        ? fields.version
        : 'unknown',
    directory: path.dirname(manifestPath),
    bin: 'bin' in fields ? fields.bin : undefined,
  };
}

function locateDrizzleKitBin(): string {
  const manifest = readPackageManifest('drizzle-kit');
  const bin = manifest.bin;
  const relativeBin =
    typeof bin === 'object' && bin !== null && 'drizzle-kit' in bin
      ? bin['drizzle-kit']
      : undefined;
  if (typeof relativeBin !== 'string') {
    throw new Error(
      `Expected drizzle-kit's package.json to have bin["drizzle-kit"] as a string, got ${JSON.stringify(bin)}`,
    );
  }
  return path.join(manifest.directory, relativeBin);
}

async function chooseEnginePort(
  requestedPort: number | undefined,
): Promise<number | undefined> {
  if (requestedPort !== undefined) {
    return (await isPortFree(requestedPort)) ? requestedPort : undefined;
  }
  if (await isPortFree(defaultPort)) return defaultPort;
  return await reserveFreePort();
}

async function isPortFree(port: number): Promise<boolean> {
  const server = net.createServer();
  const listened = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (listened)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  return listened;
}

async function reserveFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== 'object' || address === null) {
    throw new Error(
      `Expected a TCP address from a throwaway server, got ${String(address)}`,
    );
  }
  return address.port;
}

function superviseEngine(
  request: StudioEngineRequest,
  port: number,
): Promise<StudioEngineExit> {
  // detached: a terminal Ctrl-C reaches only the launcher, which then stops
  // the engine on purpose, instead of racing the engine's own SIGINT exit.
  const engine = spawn(
    process.execPath,
    [
      '--require',
      path.join(engineDirectory, 'studio-gate.cjs'),
      locateDrizzleKitBin(),
      'studio',
      '--config',
      path.join(engineDirectory, 'studio.config.cjs'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: engineDirectory,
      env: buildEngineEnvironment(request.database),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: true,
    },
  );
  let outputTail = '';
  let phase: 'starting' | 'running' = 'starting';
  let stopReason: 'stopped' | 'port-busy' | 'gate-refused' | undefined;

  const collectOutput = (chunk: Buffer): void => {
    outputTail = (outputTail + chunk.toString('utf8')).slice(-outputTailLength);
  };
  const stopEngine = (reason: typeof stopReason): void => {
    stopReason ??= reason;
    signalEngineGroup(engine.pid, 'SIGTERM');
    setTimeout(
      () => signalEngineGroup(engine.pid, 'SIGKILL'),
      stopGraceMs,
    ).unref();
  };
  const onAbort = (): void => stopEngine('stopped');
  const startTimer = setTimeout(() => stopEngine(undefined), startTimeoutMs);

  engine.stdout?.on('data', collectOutput);
  engine.stderr?.on('data', collectOutput);
  request.abortSignal.addEventListener('abort', onAbort, { once: true });
  if (request.abortSignal.aborted) onAbort();

  const announceListening = (listeningPort: number): void => {
    if (engine.pid === undefined) return;
    phase = 'running';
    clearTimeout(startTimer);
    request.onListening({
      url:
        listeningPort === defaultPort
          ? studioUrl
          : `${studioUrl}?port=${listeningPort}`,
      port: listeningPort,
      enginePid: engine.pid,
    });
  };

  engine.on('message', (message: unknown) => {
    const event = readEngineEvent(message);
    if (event === undefined) return;
    if (event.kind === 'listening') return announceListening(event.port);
    if (event.kind === 'listen-failed') {
      return stopEngine(event.code === 'EADDRINUSE' ? 'port-busy' : undefined);
    }
    stopReason ??= 'gate-refused';
  });

  return new Promise<StudioEngineExit>((resolve) => {
    engine.once('error', (error: NodeJS.ErrnoException) => {
      collectOutput(Buffer.from(`could not start the engine: ${error.code}\n`));
    });
    engine.once('close', (exitCode: number | null, signal: string | null) => {
      clearTimeout(startTimer);
      request.abortSignal.removeEventListener('abort', onAbort);
      const redactedTail = redactPassword(
        outputTail,
        request.database.password,
      );
      if (stopReason === 'stopped') return resolve({ kind: 'stopped' });
      if (stopReason === 'port-busy')
        return resolve({ kind: 'port-busy', port });
      if (stopReason === 'gate-refused') {
        return resolve({ kind: 'gate-refused', outputTail: redactedTail });
      }
      resolve({
        kind: 'engine-failed',
        phase,
        exitCode,
        signal,
        outputTail: redactedTail,
      });
    });
  });
}

function buildEngineEnvironment(
  database: StudioDatabase,
): Record<string, string> {
  const environment: Record<string, string> = {
    TYPEORM_STUDIO_DATABASE: JSON.stringify({
      host: database.host,
      port: database.port,
      user: database.user,
      database: database.database,
      // drizzle-kit turns TLS on when ssl is missing, so it is always explicit.
      ssl: database.tls === false ? false : { ...database.tls },
    }),
  };
  if (process.env.PATH !== undefined) environment.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) environment.HOME = process.env.HOME;
  if (database.password !== undefined) {
    environment.PGPASSWORD = database.password;
  }
  if (database.startupOptions !== undefined) {
    environment.PGOPTIONS = database.startupOptions;
  }
  return environment;
}

function readEngineEvent(message: unknown): EngineEvent | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const fields: Readonly<Record<string, unknown>> = { ...message };
  if (fields.channel !== engineChannel) return undefined;
  if (fields.kind === 'gate-refused') return { kind: 'gate-refused' };
  if (fields.kind === 'listen-failed') {
    return {
      kind: 'listen-failed',
      code: typeof fields.code === 'string' ? fields.code : undefined,
    };
  }
  if (fields.kind !== 'listening') return undefined;
  const port = readListeningPort(fields.address);
  return port === undefined ? undefined : { kind: 'listening', port };
}

function readListeningPort(address: unknown): number | undefined {
  if (typeof address !== 'object' || address === null) return undefined;
  if (!('port' in address) || typeof address.port !== 'number') {
    return undefined;
  }
  return address.port;
}

// The engine leads its own process group (detached), so this also reaches the
// esbuild service that drizzle-kit starts to load its config.
function signalEngineGroup(
  enginePid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (enginePid === undefined) return;
  try {
    process.kill(-enginePid, signal);
  } catch {
    // ESRCH: the group is already gone, which is the goal.
  }
}

function redactPassword(text: string, password: string | undefined): string {
  if (password === undefined || password === '') return text;
  return text.split(password).join('***');
}
