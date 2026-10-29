import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStudioEngine } from '../../src/drizzle/run-studio-engine.ts';
import type {
  StudioDatabase,
  StudioEngineExit,
} from '../../src/drizzle/run-studio-engine.ts';

type ListeningStudio = {
  readonly url: string;
  readonly port: number;
  readonly enginePid: number;
};

type RunningEngine = {
  readonly studio: ListeningStudio;
  readonly listenings: readonly ListeningStudio[];
  readonly exit: Promise<StudioEngineExit>;
  stop(): Promise<StudioEngineExit>;
};

type StudioReply = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
};

type InitReply = {
  readonly dialect: string;
  readonly packageName: string;
  readonly version: string;
  readonly dbHash?: string;
};

const postgresImage = 'postgres:18.6-alpine';
const containerPassword = 'sentinel-pw-6b21f9d4c7';
const hashRoleName = 'hash_user';
const readOnlyOptions = '-c default_transaction_read_only=on';
const studioOrigin = 'https://local.drizzle.studio';
const defaultStudioPort = 4983;
const seededAgentId = '01990000-0000-7000-8000-000000000001';
const launcherChildPath = fileURLToPath(
  new URL('./children/run-engine-and-report.ts', import.meta.url),
);

let container: StartedPostgreSqlContainer | undefined;
let adminClient: Client | undefined;

function startedContainer(): StartedPostgreSqlContainer {
  if (container === undefined) throw new Error('the container did not start');
  return container;
}

function startedAdminClient(): Client {
  if (adminClient === undefined) throw new Error('the admin client is not set');
  return adminClient;
}

function databaseOf(overrides: Partial<StudioDatabase> = {}): StudioDatabase {
  const started = startedContainer();
  return {
    host: started.getHost(),
    port: started.getPort(),
    user: started.getUsername(),
    password: started.getPassword(),
    database: started.getDatabase(),
    tls: false,
    startupOptions: undefined,
    ...overrides,
  };
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

async function occupyPort(port: number): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function releasePort(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function settleWithin<Value>(
  promise: Promise<Value>,
  ms: number,
): Promise<Value> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`did not settle within ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(
  condition: () => boolean,
  ms: number,
): Promise<boolean> {
  if (condition()) return true;
  if (ms <= 0) return false;
  await sleep(20);
  return waitUntil(condition, ms - 20);
}

function processIsGone(pid: number): boolean {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return true;
  }
  return (
    stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z'
  );
}

async function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function launchEngine(request: {
  readonly database: StudioDatabase;
  readonly port: number | undefined;
}): Promise<RunningEngine> {
  const controller = new AbortController();
  const listenings: ListeningStudio[] = [];
  let announceListening: (studio: ListeningStudio) => void = () => undefined;
  const listening = new Promise<ListeningStudio>((resolve) => {
    announceListening = resolve;
  });
  const exit = runStudioEngine({
    database: request.database,
    port: request.port,
    abortSignal: controller.signal,
    onListening: (studio): void => {
      listenings.push(studio);
      announceListening(studio);
    },
  });
  const first = await settleWithin(Promise.race([listening, exit]), 60_000);
  if ('kind' in first) {
    throw new Error(`the engine did not start: ${JSON.stringify(first)}`);
  }
  return {
    studio: first,
    listenings,
    exit,
    stop: async (): Promise<StudioEngineExit> => {
      controller.abort();
      return settleWithin(exit, 10_000);
    },
  };
}

async function withEngine(
  request: {
    readonly database: StudioDatabase;
    readonly port: number | undefined;
  },
  scenario: (engine: RunningEngine) => Promise<void>,
): Promise<void> {
  const engine = await launchEngine(request);
  try {
    await scenario(engine);
  } finally {
    await engine.stop();
  }
}

async function postStudio(
  port: number,
  body: unknown,
  headers: Readonly<Record<string, string>>,
): Promise<StudioReply> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    text: await response.text(),
  };
}

async function postAllowed(port: number, body: unknown): Promise<StudioReply> {
  return postStudio(port, body, { origin: studioOrigin });
}

async function sendWithHost(
  port: number,
  host: string,
  body: unknown,
): Promise<StudioReply> {
  const payload = JSON.stringify(body);
  return new Promise<StudioReply>((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/',
        headers: {
          host,
          origin: studioOrigin,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            headers[name] = Array.isArray(value)
              ? value.join(', ')
              : (value ?? '');
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.once('error', reject);
    request.end(payload);
  });
}

function proxyBody(sql: string, params: readonly unknown[] = []): unknown {
  return {
    type: 'proxy',
    data: { sql, params, mode: 'object', method: 'all' },
  };
}

function parseReply(reply: StudioReply): unknown {
  return JSON.parse(reply.text) as unknown;
}

async function countTenantAgents(): Promise<number> {
  const result = await startedAdminClient().query<{ total: string }>(
    'SELECT count(*)::text AS total FROM "tenant-agents"',
  );
  return Number(result.rows[0]?.total);
}

function expectForbidden(reply: StudioReply): void {
  expect(reply.status).toBe(403);
  expect(reply.headers['content-type']).toMatch(/^application\/json/);
  expect(parseReply(reply)).toEqual({ error: 'forbidden' });
  const corsHeaders = Object.keys(reply.headers).filter((name) =>
    name.toLowerCase().startsWith('access-control-'),
  );
  expect(corsHeaders).toEqual([]);
}

function expectedUrlOf(port: number): string {
  return port === defaultStudioPort
    ? studioOrigin
    : `${studioOrigin}?port=${port}`;
}

type ListeningSocket = { readonly address: string; readonly port: number };

function decodeProcNetAddress(hexAddress: string): string {
  if (hexAddress.length !== 8) return hexAddress;
  const bytes = hexAddress.match(/../g) ?? [];
  return bytes
    .reverse()
    .map((byte) => parseInt(byte, 16))
    .join('.');
}

function socketInodesOf(pid: number): Set<string> {
  const inodes = new Set<string>();
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    let target = '';
    try {
      target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
    if (inode !== undefined) inodes.add(inode);
  }
  return inodes;
}

function listeningRowsOf(pid: number, table: string): ListeningSocket[] {
  const ownedInodes = socketInodesOf(pid);
  const rows = fs.readFileSync(`/proc/${pid}/net/${table}`, 'utf8').split('\n');
  return rows
    .slice(1)
    .map((row) => row.trim().split(/\s+/))
    .filter(
      (columns) => columns[3] === '0A' && ownedInodes.has(columns[9] ?? ''),
    )
    .map((columns) => {
      const [hexAddress, hexPort] = (columns[1] ?? '').split(':');
      return {
        address: decodeProcNetAddress(hexAddress ?? ''),
        port: parseInt(hexPort ?? '', 16),
      };
    });
}

function listeningSocketsOf(pid: number): ListeningSocket[] {
  return [...listeningRowsOf(pid, 'tcp'), ...listeningRowsOf(pid, 'tcp6')];
}

function filesUnder(directory: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
  });
}

function filesContainingText(paths: readonly string[], text: string): string[] {
  return paths.filter((filePath) => {
    if (filePath.includes(text)) return true;
    try {
      return fs.readFileSync(filePath, 'latin1').includes(text);
    } catch {
      return false;
    }
  });
}

function requireEngineFailed(
  exit: StudioEngineExit,
): Extract<StudioEngineExit, { kind: 'engine-failed' }> {
  if (exit.kind !== 'engine-failed') {
    throw new Error(`expected engine-failed, got ${JSON.stringify(exit)}`);
  }
  return exit;
}

async function readInit(port: number): Promise<InitReply> {
  const reply = await postAllowed(port, { type: 'init' });
  expect(reply.status).toBe(200);
  return parseReply(reply) as InitReply;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer(postgresImage)
    .withDatabase('studio_db')
    .withUsername('studio_user')
    .withPassword(containerPassword)
    .start();
  adminClient = new Client({ connectionString: container.getConnectionUri() });
  await adminClient.connect();
  await adminClient.query(
    `CREATE TYPE "tenant-agents_status_enum" AS ENUM ('active', 'paused')`,
  );
  await adminClient.query(`
    CREATE TABLE "tenant-agents" (
      "id" uuid PRIMARY KEY DEFAULT uuidv7(),
      "name" text NOT NULL,
      "status" "tenant-agents_status_enum" NOT NULL DEFAULT 'active',
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )`);
  await adminClient.query(`
    CREATE TABLE "agent-events" (
      "id" uuid PRIMARY KEY DEFAULT uuidv7(),
      "tenantAgentId" uuid NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "agent-events_tenantAgentId_fkey"
        FOREIGN KEY ("tenantAgentId") REFERENCES "tenant-agents" ("id")
    )`);
  await adminClient.query(
    `INSERT INTO "tenant-agents" ("id", "name") VALUES ($1, 'seeded-agent')`,
    [seededAgentId],
  );
  await adminClient.query(
    `INSERT INTO "agent-events" ("tenantAgentId") VALUES ($1)`,
    [seededAgentId],
  );
  await adminClient.query(
    `CREATE ROLE "${hashRoleName}" LOGIN PASSWORD 'hash-pw-first-3391'`,
  );
});

afterAll(async () => {
  await adminClient?.end();
  await container?.stop();
});

describe('a running engine in write mode', () => {
  let engine: RunningEngine | undefined;

  function running(): RunningEngine {
    if (engine === undefined) throw new Error('the engine did not start');
    return engine;
  }

  beforeAll(async () => {
    engine = await launchEngine({
      database: databaseOf(),
      port: await reserveClosedPort(),
    });
  });

  afterAll(async () => {
    await engine?.stop();
  });

  it('calls onListening once with the url and the port', async () => {
    const { studio, listenings } = running();

    await sleep(300);

    expect(listenings).toHaveLength(1);
    expect(studio.url).toBe(expectedUrlOf(studio.port));
    expect(studio.url).toBe(`${studioOrigin}?port=${studio.port}`);
    expect(studio.enginePid).toBeGreaterThan(0);
    expect(studio.enginePid).not.toBe(process.pid);
  });

  it('answers init with a postgresql dialect on the pg driver', async () => {
    const reply = await readInit(running().studio.port);
    const [major, minor] = reply.version.split('.').map(Number);

    expect(reply.dialect).toBe('postgresql');
    expect(reply.packageName).toBe('pg');
    expect(major).toBe(6);
    expect(minor).toBeLessThanOrEqual(3);
  });

  it('selects the seeded row from a kebab-case table', async () => {
    const reply = await postAllowed(
      running().studio.port,
      proxyBody('SELECT * FROM "tenant-agents" WHERE "id" = $1', [
        seededAgentId,
      ]),
    );

    expect(reply.status).toBe(200);
    expect(parseReply(reply)).toEqual([
      expect.objectContaining({
        id: seededAgentId,
        name: 'seeded-agent',
        status: 'active',
        createdAt: expect.any(String),
      }),
    ]);
  });

  it('inserts a row that relies on the database defaults', async () => {
    const before = await countTenantAgents();

    const reply = await postAllowed(
      running().studio.port,
      proxyBody(
        'INSERT INTO "tenant-agents" ("name") VALUES ($1) RETURNING "id", "status", "createdAt"',
        ['written-through-studio'],
      ),
    );

    expect(reply.status).toBe(200);
    expect(parseReply(reply)).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        status: 'active',
        createdAt: expect.any(String),
      }),
    ]);
    expect(await countTenantAgents()).toBe(before + 1);
  });

  it('serves the allowed origin and the localhost host names through the gate', async () => {
    const { port } = running().studio;

    const byLocalhost = await sendWithHost(port, `localhost:${port}`, {
      type: 'init',
    });
    const byLoopback = await sendWithHost(port, `127.0.0.1:${port}`, {
      type: 'init',
    });
    const byIpv6Loopback = await sendWithHost(port, `[::1]:${port}`, {
      type: 'init',
    });

    expect(byLocalhost.status).toBe(200);
    expect(byLoopback.status).toBe(200);
    expect(byIpv6Loopback.status).toBe(200);
  });

  it.each([
    ['a foreign origin', { origin: 'https://evil.example' }],
    ['no origin', {}],
    [
      'an origin that only starts with the allowed one',
      { origin: 'https://local.drizzle.studio.evil.example' },
    ],
    ['the allowed host over http', { origin: 'http://local.drizzle.studio' }],
  ])('refuses %s and writes nothing', async (_label, headers) => {
    const before = await countTenantAgents();

    const reply = await postStudio(
      running().studio.port,
      proxyBody('INSERT INTO "tenant-agents" ("name") VALUES ($1)', ['gated']),
      headers,
    );

    expectForbidden(reply);
    expect(await countTenantAgents()).toBe(before);
  });

  it('refuses a foreign Host header and writes nothing', async () => {
    const { port } = running().studio;
    const before = await countTenantAgents();

    const reply = await sendWithHost(
      port,
      `evil.example:${port}`,
      proxyBody('INSERT INTO "tenant-agents" ("name") VALUES ($1)', ['gated']),
    );

    expectForbidden(reply);
    expect(await countTenantAgents()).toBe(before);
  });

  it('answers the private network preflight from the allowed origin', async () => {
    const response = await fetch(`http://127.0.0.1:${running().studio.port}/`, {
      method: 'OPTIONS',
      headers: {
        origin: studioOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-private-network': 'true',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-private-network')).toBe(
      'true',
    );
  });

  it('does not serve GET /init', async () => {
    const response = await fetch(
      `http://127.0.0.1:${running().studio.port}/init`,
      {
        headers: { origin: studioOrigin },
      },
    );

    expect(response.ok).toBe(false);
  });

  it('owns exactly one listening socket, bound to 127.0.0.1', () => {
    const { enginePid, port } = running().studio;

    expect(listeningSocketsOf(enginePid)).toEqual([
      { address: '127.0.0.1', port },
    ]);
  });
});

describe('a running engine in read-only mode', () => {
  let engine: RunningEngine | undefined;

  function running(): RunningEngine {
    if (engine === undefined) throw new Error('the engine did not start');
    return engine;
  }

  beforeAll(async () => {
    engine = await launchEngine({
      database: databaseOf({ startupOptions: readOnlyOptions }),
      port: await reserveClosedPort(),
    });
  });

  afterAll(async () => {
    await engine?.stop();
  });

  it('still reads', async () => {
    const reply = await postAllowed(
      running().studio.port,
      proxyBody('SELECT "name" FROM "tenant-agents" WHERE "id" = $1', [
        seededAgentId,
      ]),
    );

    expect(parseReply(reply)).toEqual([{ name: 'seeded-agent' }]);
  });

  it('rejects an insert and leaves the row count unchanged', async () => {
    const before = await countTenantAgents();

    const reply = await postAllowed(
      running().studio.port,
      proxyBody('INSERT INTO "tenant-agents" ("name") VALUES ($1)', [
        'read-only-probe',
      ]),
    );

    expect(reply.text).toMatch(/25006|read-only transaction/);
    expect(await countTenantAgents()).toBe(before);
  });

  it('rejects DDL and creates no table', async () => {
    const reply = await postAllowed(
      running().studio.port,
      proxyBody('CREATE TABLE "ddl-probe" ("id" integer)'),
    );

    const probe = await startedAdminClient().query(
      `SELECT 1 FROM pg_tables WHERE tablename = 'ddl-probe'`,
    );
    expect(reply.text).toMatch(/25006|read-only transaction/);
    expect(probe.rowCount).toBe(0);
  });
});

describe('the engine lifecycle', () => {
  it('stops within 3 seconds on abort, frees the port and the pid', async () => {
    const port = await reserveClosedPort();
    const engine = await launchEngine({ database: databaseOf(), port });
    const startedAt = Date.now();

    const exit = await engine.stop();

    expect(exit).toEqual({ kind: 'stopped' });
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(await portAcceptsConnections(port)).toBe(false);
    expect(
      await waitUntil(() => processIsGone(engine.studio.enginePid), 500),
    ).toBe(true);
  });

  it('resolves engine-failed in the running phase when the engine is SIGKILLed', async () => {
    const engine = await launchEngine({
      database: databaseOf(),
      port: await reserveClosedPort(),
    });

    process.kill(engine.studio.enginePid, 'SIGKILL');
    const exit = await settleWithin(engine.exit, 1000);

    expect(exit).toMatchObject({
      kind: 'engine-failed',
      phase: 'running',
      exitCode: null,
      signal: 'SIGKILL',
    });
  });

  it('takes the engine down when the launcher is SIGKILLed', async () => {
    const port = await reserveClosedPort();
    const launcher = fork(launcherChildPath, [], {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        STUDIO_TEST_REQUEST: JSON.stringify({ database: databaseOf(), port }),
      },
    });
    try {
      const enginePid = await settleWithin(
        new Promise<number>((resolve, reject) => {
          launcher.on('message', (message: { listening?: ListeningStudio }) => {
            if (message.listening !== undefined) {
              resolve(message.listening.enginePid);
            }
          });
          launcher.once('exit', () =>
            reject(new Error('launcher exited early')),
          );
        }),
        60_000,
      );
      expect(processIsGone(enginePid)).toBe(false);

      launcher.kill('SIGKILL');

      expect(await waitUntil(() => processIsGone(enginePid), 2000)).toBe(true);
      expect(await portAcceptsConnections(port)).toBe(false);
    } finally {
      launcher.kill('SIGKILL');
    }
  });
});

describe('the engine port', () => {
  it('resolves port-busy for an explicit port that is in use', async () => {
    const port = await reserveClosedPort();
    const occupant = await occupyPort(port);
    try {
      const exit = await settleWithin(
        runStudioEngine({
          database: databaseOf(),
          port,
          abortSignal: new AbortController().signal,
          onListening: (): void => {
            throw new Error('the engine listened on a busy port');
          },
        }),
        30_000,
      );

      expect(exit).toEqual({ kind: 'port-busy', port });
    } finally {
      await releasePort(occupant);
    }
  });

  it('falls back to a free port with ?port=N when 4983 is busy', async (context) => {
    const occupant = await occupyPort(defaultStudioPort).catch(
      (): undefined => undefined,
    );
    if (occupant === undefined) {
      context.skip('port 4983 is taken by something else on this machine');
      return;
    }
    try {
      await withEngine(
        { database: databaseOf(), port: undefined },
        async (engine) => {
          expect(engine.studio.port).not.toBe(defaultStudioPort);
          expect(engine.studio.url).toBe(
            `${studioOrigin}?port=${engine.studio.port}`,
          );
          expect((await readInit(engine.studio.port)).dialect).toBe(
            'postgresql',
          );
        },
      );
    } finally {
      await releasePort(occupant);
    }
  });
});

describe('secrets', () => {
  it('keeps the password out of the command line, the output and the temp directory', async () => {
    const tmpBefore = new Set(filesUnder(os.tmpdir()));
    const port = await reserveClosedPort();
    const engine = await launchEngine({ database: databaseOf(), port });
    try {
      const selected = await postAllowed(port, proxyBody('SELECT 1 AS probe'));
      expect(selected.status).toBe(200);
      expect(parseReply(selected)).toEqual([{ probe: 1 }]);

      const commandLine = fs.readFileSync(
        `/proc/${engine.studio.enginePid}/cmdline`,
        'latin1',
      );
      const newFiles = filesUnder(os.tmpdir()).filter(
        (filePath) => !tmpBefore.has(filePath),
      );
      expect(commandLine).not.toContain(containerPassword);
      expect(filesContainingText(newFiles, containerPassword)).toEqual([]);

      process.kill(engine.studio.enginePid, 'SIGKILL');
      const failed = requireEngineFailed(await settleWithin(engine.exit, 2000));
      expect(failed.outputTail).not.toContain(containerPassword);
    } finally {
      await engine.stop();
    }
  });

  it('reports the same dbHash for two runs that differ only in the password', async () => {
    const hashDatabase = (password: string): StudioDatabase =>
      databaseOf({ user: hashRoleName, password });

    const first = await withEngineInit(hashDatabase('hash-pw-first-3391'));
    await startedAdminClient().query(
      `ALTER ROLE "${hashRoleName}" PASSWORD 'hash-pw-second-8827'`,
    );
    const second = await withEngineInit(hashDatabase('hash-pw-second-8827'));

    expect(first.dbHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.dbHash).toBe(first.dbHash);
  });
});

async function withEngineInit(database: StudioDatabase): Promise<InitReply> {
  const port = await reserveClosedPort();
  let init: InitReply | undefined;
  await withEngine({ database, port }, async (engine) => {
    const selected = await postAllowed(
      engine.studio.port,
      proxyBody('SELECT 1 AS probe'),
    );
    expect(parseReply(selected)).toEqual([{ probe: 1 }]);
    init = await readInit(engine.studio.port);
  });
  if (init === undefined) throw new Error('init was not read');
  return init;
}
