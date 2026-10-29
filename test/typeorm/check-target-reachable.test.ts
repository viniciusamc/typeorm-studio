import { execFileSync, spawnSync } from 'node:child_process';
import dns from 'node:dns';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { checkTargetReachable } from '../../src/typeorm/check-target-reachable.ts';
import type { ReachabilityVerdict } from '../../src/typeorm/check-target-reachable.ts';
import {
  makeTargetReadOnly,
  resolveConnectionTarget,
  toPgClientConfig,
} from '../../src/typeorm/resolve-connection-target.ts';
import type { ConnectionTarget } from '../../src/typeorm/resolve-connection-target.ts';

type ScriptedServer = {
  readonly port: number;
  close(): Promise<void>;
};

const postgresImage = 'postgres:18.6-alpine';
const rightPassword = 'probe-right-pw-4417';
const wrongPassword = 'probe-wrong-pw-9082';
const timeoutMs = 5000;
const opensslAvailable =
  spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
const tlsOnlyHba = [
  'local all all trust',
  'host all all 127.0.0.1/32 trust',
  'host all all ::1/128 trust',
  'hostssl all all all scram-sha-256',
  '',
].join('\n');

async function startContainer(
  configure: (container: PostgreSqlContainer) => PostgreSqlContainer,
): Promise<StartedPostgreSqlContainer> {
  return configure(
    new PostgreSqlContainer(postgresImage)
      .withDatabase('probe_db')
      .withUsername('probe_user')
      .withPassword(rightPassword),
  ).start();
}

function targetOf(
  container: StartedPostgreSqlContainer | undefined,
  overrides: Partial<ConnectionTarget> = {},
): ConnectionTarget {
  if (container === undefined) throw new Error('the container did not start');
  return {
    dialect: 'postgres',
    typeormType: 'postgres',
    host: 'localhost',
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
    tls: false,
    applicationName: undefined,
    startupOptions: undefined,
    ...overrides,
  };
}

async function probeWithinBudget(
  target: ConnectionTarget,
): Promise<ReachabilityVerdict> {
  const startedAt = performance.now();
  const verdict = await checkTargetReachable(target, { timeoutMs });
  const serialized = JSON.stringify(verdict);

  expect(performance.now() - startedAt).toBeLessThan(6000);
  expect(serialized).not.toContain(rightPassword);
  expect(serialized).not.toContain(wrongPassword);
  return verdict;
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

async function startScriptedServer(
  onConnection: (socket: net.Socket) => void,
): Promise<ScriptedServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('the scripted server has no port');
  }
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function errorResponse(sqlState: string, message: string): Buffer {
  const fields = Buffer.from(
    `SFATAL\0VFATAL\0C${sqlState}\0M${message}\0\0`,
    'utf8',
  );
  const length = Buffer.alloc(4);
  length.writeInt32BE(fields.length + 4);
  return Buffer.concat([Buffer.from('E'), length, fields]);
}

function authenticationOkAndReady(): Buffer {
  const authenticationOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
  const readyForQuery = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
  return Buffer.concat([authenticationOk, readyForQuery]);
}

function answerFirstPacketWith(reply: Buffer): (socket: net.Socket) => void {
  return (socket) => {
    socket.once('data', () => {
      socket.end(reply);
    });
  };
}

function scriptedTarget(
  server: ScriptedServer,
  overrides: Partial<ConnectionTarget> = {},
): ConnectionTarget {
  return {
    dialect: 'postgres',
    typeormType: 'postgres',
    host: '127.0.0.1',
    port: server.port,
    user: 'scripted_user',
    password: rightPassword,
    database: 'scripted_db',
    tls: false,
    applicationName: undefined,
    startupOptions: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  for (const name of [
    'PGPASSWORD',
    'PGOPTIONS',
    'PGSSLMODE',
    'PGSSLNEGOTIATION',
    'PGAPPNAME',
  ]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('against a real postgres', () => {
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startContainer((started) => started);
  });

  afterAll(async () => {
    await container?.stop();
  });

  it('reaches the database and reports that writes are allowed', async () => {
    const resolved = await resolveConnectionTarget({
      type: 'postgres',
      host: 'localhost',
      port: container?.getPort(),
      username: container?.getUsername(),
      password: container?.getPassword(),
      database: container?.getDatabase(),
    });
    if (resolved.kind !== 'target') throw new Error('expected a target');

    await expect(probeWithinBudget(resolved.target)).resolves.toEqual({
      reachable: true,
      elapsedMs: expect.any(Number),
      readOnly: false,
    });
  });

  it('reports readOnly for a read-only target and the server refuses an INSERT with 25006', async () => {
    const base = targetOf(container);
    const admin = new Client(toPgClientConfig(base));
    await admin.connect();
    try {
      await admin.query('CREATE TABLE probe_items (id integer)');
    } finally {
      await admin.end();
    }

    const readOnlyTarget = makeTargetReadOnly(base);
    const verdict = await probeWithinBudget(readOnlyTarget);
    const readOnlyClient = new Client(toPgClientConfig(readOnlyTarget));
    await readOnlyClient.connect();
    try {
      await expect(
        readOnlyClient.query('INSERT INTO probe_items (id) VALUES (1)'),
      ).rejects.toMatchObject({ code: '25006' });
    } finally {
      await readOnlyClient.end();
    }

    expect(verdict).toEqual({
      reachable: true,
      elapsedMs: expect.any(Number),
      readOnly: true,
    });
  });

  it('keeps the startup options the target already had next to the read-only one', async () => {
    const target = makeTargetReadOnly(
      targetOf(container, { startupOptions: '-c search_path=public' }),
    );

    await expect(probeWithinBudget(target)).resolves.toMatchObject({
      reachable: true,
      readOnly: true,
    });
  });

  it('maps a wrong password to authentication-failed with SQLSTATE 28P01', async () => {
    const verdict = await probeWithinBudget(
      targetOf(container, { password: wrongPassword }),
    );

    expect(verdict).toEqual({
      reachable: false,
      reason: 'authentication-failed',
      driverCode: '28P01',
    });
  });

  it('maps a missing password to authentication-failed', async () => {
    const verdict = await probeWithinBudget(
      targetOf(container, { password: undefined }),
    );

    expect(verdict).toMatchObject({
      reachable: false,
      reason: 'authentication-failed',
    });
  });

  it('maps an unknown role to authentication-failed', async () => {
    const verdict = await probeWithinBudget(
      targetOf(container, { user: 'role_that_does_not_exist' }),
    );

    expect(verdict).toMatchObject({
      reachable: false,
      reason: 'authentication-failed',
    });
  });

  it('maps an unknown database to database-not-found with SQLSTATE 3D000', async () => {
    const verdict = await probeWithinBudget(
      targetOf(container, { database: 'database_that_does_not_exist' }),
    );

    expect(verdict).toEqual({
      reachable: false,
      reason: 'database-not-found',
      driverCode: '3D000',
    });
  });

  it('maps a closed port to connection-refused with ECONNREFUSED', async () => {
    const verdict = await probeWithinBudget(
      targetOf(container, {
        host: '127.0.0.1',
        port: await reserveClosedPort(),
      }),
    );

    expect(verdict).toEqual({
      reachable: false,
      reason: 'connection-refused',
      driverCode: 'ECONNREFUSED',
    });
  });

  it('maps a closed port reached through "localhost" to connection-refused', async () => {
    const verdict = await probeWithinBudget(
      targetOf(container, {
        host: 'localhost',
        port: await reserveClosedPort(),
      }),
    );

    expect(verdict).toEqual({
      reachable: false,
      reason: 'connection-refused',
      driverCode: 'ECONNREFUSED',
    });
  });

  it('maps TLS requested against a server without TLS to tls-not-supported-by-server', async () => {
    const verdict = await probeWithinBudget(
      targetOf(container, { tls: { rejectUnauthorized: true } }),
    );

    expect(verdict).toEqual({
      reachable: false,
      reason: 'tls-not-supported-by-server',
      driverCode: undefined,
    });
  });

  it('maps a startup option the server does not know to startup-options-rejected', async () => {
    const verdict = await probeWithinBudget(
      targetOf(container, { startupOptions: '-c not_a_real_setting=1' }),
    );

    expect(verdict).toEqual({
      reachable: false,
      reason: 'startup-options-rejected',
      driverCode: '42704',
    });
  });

  it('never carries the driver message, the user or the database in the verdict', async () => {
    const verdicts = [
      await probeWithinBudget(targetOf(container, { password: wrongPassword })),
      await probeWithinBudget(targetOf(container, { database: 'nope_db' })),
    ];

    const serialized = JSON.stringify(verdicts);

    expect(serialized).not.toContain('probe_user');
    expect(serialized).not.toContain('nope_db');
    expect(serialized).not.toMatch(/authentication failed|does not exist/i);
  });

  it('leaves no connection open after a verdict', async () => {
    const monitor = new Client(toPgClientConfig(targetOf(container)));
    await monitor.connect();
    try {
      await probeWithinBudget(targetOf(container));
      await probeWithinBudget(targetOf(container, { password: wrongPassword }));
      const open = await monitor.query<{ count: string }>(
        "SELECT count(*) AS count FROM pg_stat_activity WHERE datname = 'probe_db' AND pid <> pg_backend_pid()",
      );

      expect(open.rows[0]?.count).toBe('0');
    } finally {
      await monitor.end();
    }
  });
});

describe.skipIf(!opensslAvailable)(
  'against a real postgres that only accepts TLS',
  () => {
    let container: StartedPostgreSqlContainer | undefined;
    let certDirectory = '';
    let certificate = '';

    beforeAll(async () => {
      certDirectory = mkdtempSync(path.join(os.tmpdir(), 'typeorm-studio-'));
      const certFile = path.join(certDirectory, 'server.crt');
      const keyFile = path.join(certDirectory, 'server.key');
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyFile,
          '-out',
          certFile,
          '-days',
          '2',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost',
        ],
        { stdio: 'ignore' },
      );
      certificate = readFileSync(certFile, 'utf8');
      container = await startContainer((started) =>
        started
          .withSSL(certFile, keyFile)
          .withCopyContentToContainer([
            {
              content: tlsOnlyHba,
              target: '/etc/typeorm-studio-test/pg_hba.conf',
              mode: 0o644,
            },
          ])
          .withCommand([
            'postgres',
            '-c',
            'hba_file=/etc/typeorm-studio-test/pg_hba.conf',
          ]),
      );
    });

    afterAll(async () => {
      await container?.stop();
      rmSync(certDirectory, { recursive: true, force: true });
    });

    it('reaches the database over TLS verified against the configured CA', async () => {
      const verdict = await probeWithinBudget(
        targetOf(container, {
          tls: { rejectUnauthorized: true, ca: certificate },
        }),
      );

      expect(verdict).toMatchObject({ reachable: true, readOnly: false });
    });

    it('reaches the database over TLS when verification is switched off', async () => {
      const verdict = await probeWithinBudget(
        targetOf(container, { tls: { rejectUnauthorized: false } }),
      );

      expect(verdict).toMatchObject({ reachable: true });
    });

    it('verifies the certificate against servername when the host is an IP address', async () => {
      const verdict = await probeWithinBudget(
        targetOf(container, {
          host: '127.0.0.1',
          tls: {
            rejectUnauthorized: true,
            ca: certificate,
            servername: 'localhost',
          },
        }),
      );

      expect(verdict).toMatchObject({ reachable: true });
    });

    it('maps a self-signed certificate that is not trusted to tls-verification-failed', async () => {
      const verdict = await probeWithinBudget(
        targetOf(container, { tls: { rejectUnauthorized: true } }),
      );

      expect(verdict).toEqual({
        reachable: false,
        reason: 'tls-verification-failed',
        driverCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
    });

    it('maps a certificate that does not match the host to tls-verification-failed', async () => {
      const verdict = await probeWithinBudget(
        targetOf(container, {
          host: '127.0.0.1',
          tls: { rejectUnauthorized: true, ca: certificate },
        }),
      );

      expect(verdict).toEqual({
        reachable: false,
        reason: 'tls-verification-failed',
        driverCode: 'ERR_TLS_CERT_ALTNAME_INVALID',
      });
    });

    it('maps the pg_hba.conf rejection of an unencrypted connection to tls-required-by-server', async () => {
      const verdict = await probeWithinBudget(targetOf(container));

      expect(verdict).toEqual({
        reachable: false,
        reason: 'tls-required-by-server',
        driverCode: '28000',
      });
    });

    it('still reports a wrong password as authentication-failed over TLS', async () => {
      const verdict = await probeWithinBudget(
        targetOf(container, {
          password: wrongPassword,
          tls: { rejectUnauthorized: true, ca: certificate },
        }),
      );

      expect(verdict).toEqual({
        reachable: false,
        reason: 'authentication-failed',
        driverCode: '28P01',
      });
    });
  },
);

describe('against a scripted server', () => {
  let activeServer: ScriptedServer | undefined;

  async function serve(
    onConnection: (socket: net.Socket) => void,
  ): Promise<ScriptedServer> {
    if (activeServer) throw new Error('one scripted server per test');
    activeServer = await startScriptedServer(onConnection);
    return activeServer;
  }

  afterEach(async () => {
    await activeServer?.close();
    activeServer = undefined;
  });

  it.each([
    {
      label: 'a pg_hba.conf rejection of an unencrypted connection',
      sqlState: '28000',
      message:
        'no pg_hba.conf entry for host "10.0.0.7", user "scripted_user", database "scripted_db", no encryption',
      reason: 'tls-required-by-server',
    },
    {
      label: 'the same rejection worded by an older server',
      sqlState: '28000',
      message:
        'no pg_hba.conf entry for host "10.0.0.7", user "scripted_user", database "scripted_db", SSL off',
      reason: 'tls-required-by-server',
    },
    {
      label: 'a pg_hba.conf rejection of an encrypted connection',
      sqlState: '28000',
      message:
        'no pg_hba.conf entry for host "10.0.0.7", user "scripted_user", database "scripted_db", SSL encryption',
      reason: 'authentication-failed',
    },
    {
      label: 'a role that does not exist',
      sqlState: '28000',
      message: 'role "scripted_user" does not exist',
      reason: 'authentication-failed',
    },
    {
      label: 'a bad password',
      sqlState: '28P01',
      message: 'password authentication failed for user "scripted_user"',
      reason: 'authentication-failed',
    },
    {
      label: 'a missing CONNECT privilege',
      sqlState: '42501',
      message: 'permission denied for database "scripted_db"',
      reason: 'authentication-failed',
    },
    {
      label: 'an unknown database',
      sqlState: '3D000',
      message: 'database "scripted_db" does not exist',
      reason: 'database-not-found',
    },
  ] as const)(
    'maps $label (SQLSTATE $sqlState) to $reason',
    async ({ sqlState, message, reason }) => {
      const server = await serve(
        answerFirstPacketWith(errorResponse(sqlState, message)),
      );

      const verdict = await probeWithinBudget(scriptedTarget(server));

      expect(verdict).toEqual({
        reachable: false,
        reason,
        driverCode: sqlState,
      });
    },
  );

  it.each([
    ['08P01', 'unsupported startup parameter: options'],
    ['42704', 'unrecognized configuration parameter "search_pathh"'],
    ['22023', 'invalid value for parameter "search_path"'],
  ])(
    'maps SQLSTATE %s to startup-options-rejected only when startup options were sent',
    async (sqlState, message) => {
      const server = await serve(
        answerFirstPacketWith(errorResponse(sqlState, message)),
      );

      const withOptions = await probeWithinBudget(
        scriptedTarget(server, { startupOptions: '-c search_path=app' }),
      );
      const withoutOptions = await probeWithinBudget(scriptedTarget(server));

      expect(withOptions).toEqual({
        reachable: false,
        reason: 'startup-options-rejected',
        driverCode: sqlState,
      });
      expect(withoutOptions).toEqual({
        reachable: false,
        reason: 'unknown',
        driverCode: sqlState,
      });
    },
  );

  it('keeps the SQLSTATE of errors it has no reason for', async () => {
    const server = await serve(
      answerFirstPacketWith(
        errorResponse('57P03', 'the database system is starting up'),
      ),
    );

    await expect(probeWithinBudget(scriptedTarget(server))).resolves.toEqual({
      reachable: false,
      reason: 'unknown',
      driverCode: '57P03',
    });
  });

  it('never repeats the server message, the user, the database or the password', async () => {
    const message = `FATAL detail ${rightPassword} for scripted_user on scripted_db`;
    const server = await serve(
      answerFirstPacketWith(errorResponse('28P01', message)),
    );

    const serialized = JSON.stringify(
      await probeWithinBudget(scriptedTarget(server)),
    );

    expect(serialized).not.toContain(rightPassword);
    expect(serialized).not.toContain('scripted_user');
    expect(serialized).not.toContain('scripted_db');
    expect(serialized).not.toContain('detail');
  });

  it('maps a server that answers N to the TLS request to tls-not-supported-by-server', async () => {
    const server = await serve(answerFirstPacketWith(Buffer.from('N')));

    const verdict = await probeWithinBudget(
      scriptedTarget(server, { tls: { rejectUnauthorized: false } }),
    );

    expect(verdict).toMatchObject({
      reachable: false,
      reason: 'tls-not-supported-by-server',
    });
  });

  it('maps a unix socket directory without a socket to connection-refused with ENOENT', async () => {
    const verdict = await probeWithinBudget(
      scriptedTarget(
        { port: 5432, close: async () => undefined },
        { host: path.join(os.tmpdir(), 'typeorm-studio-no-such-socket-dir') },
      ),
    );

    expect(verdict).toEqual({
      reachable: false,
      reason: 'connection-refused',
      driverCode: 'ENOENT',
    });
  });

  it('maps a server that accepts the connection and never answers to timeout', async () => {
    const server = await serve(() => undefined);
    const startedAt = performance.now();

    const verdict = await checkTargetReachable(scriptedTarget(server), {
      timeoutMs: 300,
    });

    expect(verdict).toEqual({
      reachable: false,
      reason: 'timeout',
      driverCode: undefined,
    });
    expect(performance.now() - startedAt).toBeLessThan(1500);
  });

  it('shares one timeout budget between connecting and the queries', async () => {
    const server = await serve((socket) => {
      socket.once('data', () => {
        setTimeout(() => socket.write(authenticationOkAndReady()), 300);
      });
    });
    const startedAt = performance.now();

    const verdict = await checkTargetReachable(scriptedTarget(server), {
      timeoutMs: 500,
    });

    expect(verdict).toEqual({
      reachable: false,
      reason: 'timeout',
      driverCode: undefined,
    });
    expect(performance.now() - startedAt).toBeLessThan(700);
  });

  it('survives a server that drops the connection in the middle of the probe', async () => {
    const server = await serve((socket) => {
      socket.once('data', () => {
        socket.write(authenticationOkAndReady());
        socket.once('data', () => socket.destroy());
      });
    });

    const verdict = await probeWithinBudget(scriptedTarget(server));

    expect(verdict).toMatchObject({ reachable: false, reason: 'unknown' });
  });

  it('survives a server that closes the connection without a word', async () => {
    const server = await serve((socket) => socket.destroy());

    const verdict = await probeWithinBudget(scriptedTarget(server));

    expect(verdict).toMatchObject({ reachable: false, reason: 'unknown' });
  });

  it.each([
    ['ENOTFOUND', 'host-not-found'],
    ['EAI_AGAIN', 'host-not-found'],
  ] as const)(
    'maps a name lookup that fails with %s to %s',
    async (code, reason) => {
      vi.spyOn(dns, 'lookup').mockImplementation(((
        hostname: string,
        _options: unknown,
        callback: (error: NodeJS.ErrnoException) => void,
      ) => {
        callback(
          Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), {
            code,
            syscall: 'getaddrinfo',
          }),
        );
      }) as never);

      const verdict = await probeWithinBudget({
        ...scriptedTarget({ port: 5432, close: async () => undefined }),
        host: 'database.host.invalid',
      });

      expect(verdict).toEqual({ reachable: false, reason, driverCode: code });
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a timeoutMs of %s instead of probing without a limit',
    async (invalidTimeout) => {
      await expect(
        checkTargetReachable(
          scriptedTarget({ port: 5432, close: async () => undefined }),
          { timeoutMs: invalidTimeout },
        ),
      ).rejects.toThrow(RangeError);
    },
  );
});
