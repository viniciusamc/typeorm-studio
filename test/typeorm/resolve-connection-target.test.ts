import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Client, defaults } from 'pg';
import type { ClientConfig } from 'pg';
import { DataSource as DataSourceCurrent } from 'typeorm';
import { DataSource as DataSourceLegacy } from 'typeorm-0.3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeTarget,
  EnvironmentNotLoadedError,
  makeTargetReadOnly,
  resolveConnectionTarget,
  toPgClientConfig,
} from '../../src/typeorm/resolve-connection-target.ts';
import type {
  ConnectionTarget,
  PostgresTls,
} from '../../src/typeorm/resolve-connection-target.ts';

type TypeormDataSourceClass = new (options: never) => {
  readonly driver: { connect(): Promise<void> };
};

type PgParameters = {
  readonly host: string;
  readonly port: number;
  readonly user: string | undefined;
  readonly database: string | undefined;
  readonly password: unknown;
  readonly ssl: unknown;
  readonly application_name: string | undefined;
  readonly options: string | undefined;
};

type GoldenCase = {
  readonly name: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly expected: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string | undefined;
    readonly database: string;
    readonly tls: PostgresTls;
    readonly applicationName?: string;
    readonly startupOptions?: string;
  };
};

const passwordSentinel = 'sentinel-secret-5521';
const defaultUser = defaults.user ?? '';
const fakeCa =
  '-----BEGIN CERTIFICATE-----\nFAKE-CA-0001\n-----END CERTIFICATE-----\n';
const fakeCert =
  '-----BEGIN CERTIFICATE-----\nFAKE-CERT-0002\n-----END CERTIFICATE-----\n';
const fakeKey =
  '-----BEGIN PRIVATE KEY-----\nFAKE-KEY-0003\n-----END PRIVATE KEY-----\n';

const environmentNamesThatChangeTheTarget = [
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'PGSSLMODE',
  'PGAPPNAME',
  'PGOPTIONS',
  'PGCONNECT_TIMEOUT',
  'PGSSLNEGOTIATION',
  'PGCLIENTENCODING',
  'NODE_TLS_REJECT_UNAUTHORIZED',
];

const goldenCases: readonly GoldenCase[] = [
  {
    name: 'plain fields',
    options: {
      host: 'db.internal.test',
      port: 5433,
      username: 'app_user',
      password: 'pw-plain-0001',
      database: 'appdb',
    },
    expected: {
      host: 'db.internal.test',
      port: 5433,
      user: 'app_user',
      password: 'pw-plain-0001',
      database: 'appdb',
      tls: false,
    },
  },
  {
    name: 'url beats every discrete field',
    options: {
      url: 'postgres://url_user:url-pw-0002@url-host.test:6543/url_db',
      host: 'ignored-host.test',
      port: 1111,
      username: 'ignored_user',
      password: 'ignored-pw',
      database: 'ignored_db',
    },
    expected: {
      host: 'url-host.test',
      port: 6543,
      user: 'url_user',
      password: 'url-pw-0002',
      database: 'url_db',
      tls: false,
    },
  },
  {
    name: 'url with blank parts ignores the explicit fields and falls to PG* env',
    options: {
      url: 'postgres://h2/d2',
      username: 'explicit_user',
      password: 'explicit-pw',
      port: 7777,
    },
    env: { PGUSER: 'env_user', PGPASSWORD: 'env-pw-0003', PGPORT: '6000' },
    expected: {
      host: 'h2',
      port: 6000,
      user: 'env_user',
      password: 'env-pw-0003',
      database: 'd2',
      tls: false,
    },
  },
  {
    name: 'url with blank parts falls to pg defaults without PG* env',
    options: {
      url: 'postgres://h2/d2',
      username: 'explicit_user',
      password: 'explicit-pw',
      port: 7777,
    },
    expected: {
      host: 'h2',
      port: 5432,
      user: defaultUser,
      password: undefined,
      database: 'd2',
      tls: false,
    },
  },
  {
    name: 'replication.master credentials replace the top-level credentials',
    options: {
      host: 'top-host.test',
      port: 5432,
      username: 'top_user',
      password: 'top-pw',
      database: 'top_db',
      applicationName: 'top-app',
      replication: {
        master: {
          host: 'master-host.test',
          port: 5440,
          username: 'master_user',
          password: 'master-pw-0004',
          database: 'master_db',
        },
        slaves: [],
      },
    },
    expected: {
      host: 'master-host.test',
      port: 5440,
      user: 'master_user',
      password: 'master-pw-0004',
      database: 'master_db',
      tls: false,
      applicationName: 'top-app',
    },
  },
  {
    name: 'extra.ssl overrides ssl',
    options: {
      host: 'db.test',
      username: 'u',
      password: 'p',
      database: 'd',
      ssl: false,
      extra: { ssl: { rejectUnauthorized: false } },
    },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'd',
      tls: { rejectUnauthorized: false },
    },
  },
  {
    name: 'extra.options becomes startupOptions and extra.application_name wins',
    options: {
      host: 'db.test',
      username: 'u',
      password: 'p',
      database: 'd',
      applicationName: 'from-option',
      extra: { options: '-c search_path=app', application_name: 'from-extra' },
    },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'd',
      tls: false,
      applicationName: 'from-extra',
      startupOptions: '-c search_path=app',
    },
  },
  {
    name: 'extra.host is spread last and replaces host',
    options: {
      host: 'option-host.test',
      username: 'u',
      database: 'd',
      extra: { host: 'extra-host.test' },
    },
    expected: {
      host: 'extra-host.test',
      port: 5432,
      user: 'u',
      password: undefined,
      database: 'd',
      tls: false,
    },
  },
  {
    name: 'sslmode=require in the url',
    options: { url: 'postgres://u:p@db.test:5432/d?sslmode=require' },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'd',
      tls: { rejectUnauthorized: true },
    },
  },
  {
    name: 'sslmode=disable in the url beats ssl: true',
    options: {
      url: 'postgres://u:p@db.test:5432/d?sslmode=disable',
      ssl: true,
    },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'd',
      tls: false,
    },
  },
  {
    name: 'sslmode=no-verify in the url',
    options: { url: 'postgres://u:p@db.test:5432/d?sslmode=no-verify' },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'd',
      tls: { rejectUnauthorized: false },
    },
  },
  {
    name: 'ssl object with ca, cert (Buffer), key, passphrase and servername',
    options: {
      host: 'db.test',
      username: 'u',
      password: 'p',
      database: 'd',
      ssl: {
        rejectUnauthorized: true,
        ca: fakeCa,
        cert: Buffer.from(fakeCert),
        key: fakeKey,
        passphrase: 'key-passphrase-0005',
        servername: 'db.public.test',
      },
    },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'd',
      tls: {
        rejectUnauthorized: true,
        ca: fakeCa,
        cert: fakeCert,
        key: fakeKey,
        passphrase: 'key-passphrase-0005',
        servername: 'db.public.test',
      },
    },
  },
  {
    name: 'ssl: true',
    options: { host: 'db.test', username: 'u', database: 'd', ssl: true },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'u',
      password: undefined,
      database: 'd',
      tls: { rejectUnauthorized: true },
    },
  },
  {
    name: 'ssl: {} keeps verification on',
    options: { host: 'db.test', username: 'u', database: 'd', ssl: {} },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'u',
      password: undefined,
      database: 'd',
      tls: { rejectUnauthorized: true },
    },
  },
  {
    name: 'function password (sync)',
    options: {
      host: 'db.test',
      username: 'u',
      database: 'd',
      password: () => 'sync-pw-0006',
    },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'u',
      password: 'sync-pw-0006',
      database: 'd',
      tls: false,
    },
  },
  {
    name: 'function password (async)',
    options: {
      host: 'db.test',
      username: 'u',
      database: 'd',
      password: async () => 'async-pw-0007',
    },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'u',
      password: 'async-pw-0007',
      database: 'd',
      tls: false,
    },
  },
  {
    name: 'unix socket host',
    options: {
      host: '/var/run/postgresql',
      username: 'u',
      password: 'p',
      database: 'd',
    },
    expected: {
      host: '/var/run/postgresql',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'd',
      tls: false,
    },
  },
  {
    name: 'applicationName',
    options: {
      host: 'db.test',
      username: 'u',
      database: 'd',
      applicationName: 'billing-api',
    },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'u',
      password: undefined,
      database: 'd',
      tls: false,
      applicationName: 'billing-api',
    },
  },
  {
    name: 'port given as a numeric string',
    options: { host: 'db.test', port: '5433', username: 'u', database: 'd' },
    expected: {
      host: 'db.test',
      port: 5433,
      user: 'u',
      password: undefined,
      database: 'd',
      tls: false,
    },
  },
  {
    name: 'ipv6 host inside a url',
    options: { url: 'postgres://u:p@[::1]:5433/d' },
    expected: {
      host: '::1',
      port: 5433,
      user: 'u',
      password: 'p',
      database: 'd',
      tls: false,
    },
  },
  {
    name: 'PG* env fallbacks for every blank field',
    options: {},
    env: {
      PGHOST: 'env-host.test',
      PGPORT: '5999',
      PGUSER: 'env_user',
      PGPASSWORD: 'env-pw-0008',
      PGDATABASE: 'env_db',
      PGSSLMODE: 'require',
      PGAPPNAME: 'env-app',
      PGOPTIONS: '-c statement_timeout=5000',
    },
    expected: {
      host: 'env-host.test',
      port: 5999,
      user: 'env_user',
      password: 'env-pw-0008',
      database: 'env_db',
      tls: { rejectUnauthorized: true },
      applicationName: 'env-app',
      startupOptions: '-c statement_timeout=5000',
    },
  },
  {
    name: 'database falls back to the user name',
    options: { host: 'db.test', username: 'only_user' },
    expected: {
      host: 'db.test',
      port: 5432,
      user: 'only_user',
      password: undefined,
      database: 'only_user',
      tls: false,
    },
  },
];

async function captureTypeormPoolLiteral(
  DataSourceClass: TypeormDataSourceClass,
  options: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const recorded: Record<string, unknown>[] = [];
  class RecordingPool {
    constructor(config: Record<string, unknown>) {
      recorded.push(config);
    }
    on(): void {}
    connect(callback: (error: Error) => void): void {
      callback(new Error('recording pool never connects'));
    }
  }
  const dataSource = new DataSourceClass({
    ...options,
    driver: { Pool: RecordingPool },
  } as never);
  await dataSource.driver.connect().catch(() => undefined);
  const literal = recorded.at(-1);
  if (literal === undefined) {
    throw new Error('the TypeORM driver never created a pool');
  }
  return literal;
}

function readPgParameters(literal: Record<string, unknown>): PgParameters {
  const client = new Client(literal as ClientConfig);
  return Reflect.get(client, 'connectionParameters') as PgParameters;
}

async function resolveTarget(
  options: Readonly<Record<string, unknown>>,
): Promise<ConnectionTarget> {
  const resolved = await resolveConnectionTarget(options);
  if (resolved.kind !== 'target') {
    throw new Error(
      `expected a target, got unsupported ${resolved.typeormType}`,
    );
  }
  return resolved.target;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readInstalledVersion(specifier: string): string {
  const entry = createRequire(import.meta.url).resolve(specifier);
  const manifest = readFileSync(
    path.join(path.dirname(entry), 'package.json'),
    'utf8',
  );
  return (JSON.parse(manifest) as { version: string }).version;
}

const baseTarget: ConnectionTarget = {
  dialect: 'postgres',
  typeormType: 'postgres',
  host: 'db.test',
  port: 5433,
  user: 'app_user',
  password: passwordSentinel,
  database: 'appdb',
  tls: false,
  applicationName: undefined,
  startupOptions: undefined,
};

let scratchDirectory = '';

beforeEach(() => {
  scratchDirectory = mkdtempSync(path.join(os.tmpdir(), 'typeorm-studio-'));
  for (const name of environmentNamesThatChangeTheTarget) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratchDirectory, { recursive: true, force: true });
});

describe('installed TypeORM versions under test', () => {
  it('has the 1.1 line as "typeorm" and 0.3.30 as "typeorm-0.3"', () => {
    expect(readInstalledVersion('typeorm')).toMatch(/^1\.1\./);
    expect(readInstalledVersion('typeorm-0.3')).toBe('0.3.30');
  });
});

describe.each([
  ['typeorm 1.1.x', DataSourceCurrent],
  ['typeorm 0.3.30', DataSourceLegacy],
] as const)('golden table against %s', (_label, DataSourceClass) => {
  for (const goldenCase of goldenCases) {
    it(goldenCase.name, async () => {
      for (const [name, value] of Object.entries(goldenCase.env ?? {})) {
        vi.stubEnv(name, value);
      }
      const options = { type: 'postgres', ...goldenCase.options };

      const literal = await captureTypeormPoolLiteral(DataSourceClass, options);
      const pg = readPgParameters(literal);
      const target = await resolveTarget(options);

      expect(target.host).toBe(pg.host);
      expect(target.port).toBe(pg.port);
      expect(target.user).toBe(pg.user ?? '');
      expect(target.database).toBe(pg.database ?? '');
      expect(target.applicationName).toBe(pg.application_name);
      expect(target.startupOptions).toBe(pg.options);
      if (typeof pg.password !== 'function') {
        expect(target.password).toBe(pg.password ?? undefined);
      }
      expect(Boolean(pg.ssl)).toBe(target.tls !== false);

      expect(target).toMatchObject({
        dialect: 'postgres',
        typeormType: 'postgres',
        ...goldenCase.expected,
      });
      expect(target.tls).toEqual(goldenCase.expected.tls);
    });
  }
});

describe.each([
  ['typeorm 1.1.x', DataSourceCurrent],
  ['typeorm 0.3.30', DataSourceLegacy],
] as const)(
  'why the environment check runs before pg, %s',
  (_label, DataSourceClass) => {
    it('hands pg the literal "undefined" host untouched, so only the check can catch it', async () => {
      const options = {
        type: 'postgres',
        host: 'undefined',
        port: 5432,
        username: 'u',
        database: 'd',
      };

      const pg = readPgParameters(
        await captureTypeormPoolLiteral(DataSourceClass, options),
      );

      expect(pg.host).toBe('undefined');
      await expect(resolveConnectionTarget(options)).rejects.toMatchObject({
        name: 'EnvironmentNotLoadedError',
        optionKey: 'host',
      });
    });

    it('lets pg turn a NaN port into 5432 silently, so only the check can catch it', async () => {
      const options = {
        type: 'postgres',
        host: 'h',
        port: Number.NaN,
        username: 'u',
        database: 'd',
      };

      const pg = readPgParameters(
        await captureTypeormPoolLiteral(DataSourceClass, options),
      );

      expect(pg.port).toBe(5432);
      await expect(resolveConnectionTarget(options)).rejects.toMatchObject({
        name: 'EnvironmentNotLoadedError',
        optionKey: 'port',
      });
    });
  },
);

describe('environment not loaded', () => {
  it.each([
    ['host', { host: 'undefined', port: 5432, username: 'u', database: 'd' }],
    ['username', { host: 'h', username: 'undefined', database: 'd' }],
    ['database', { host: 'h', username: 'u', database: 'undefined' }],
    ['port', { host: 'h', port: Number.NaN, username: 'u', database: 'd' }],
    ['port', { host: 'h', port: Number('undefined'), username: 'u' }],
    ['port', { host: 'h', port: 'undefined', username: 'u' }],
    ['port', { host: 'h', port: 'not-a-port', username: 'u' }],
  ])('names the option key %s', async (optionKey, options) => {
    const error = await captureRejection(
      resolveConnectionTarget({ type: 'postgres', ...options }),
    );

    expect(error).toBeInstanceOf(EnvironmentNotLoadedError);
    expect((error as EnvironmentNotLoadedError).optionKey).toBe(optionKey);
    expect((error as Error).message).toContain(`"${optionKey}"`);
  });

  it.each([
    ['user', `postgres://undefined:${passwordSentinel}@h:5432/d`],
    ['password', 'postgres://app:undefined@h:5432/d'],
    ['host', `postgres://app:${passwordSentinel}@undefined:5432/d`],
    ['port', `postgres://app:${passwordSentinel}@h:undefined/d`],
    ['database', `postgres://app:${passwordSentinel}@h:5432/undefined`],
    [
      'user',
      'postgres://undefined:undefined@undefined:undefined/undefined?sslmode=require',
    ],
  ])(
    'names "url" when the %s part of the url is "undefined"',
    async (part, url) => {
      const error = await captureRejection(
        resolveConnectionTarget({ type: 'postgres', url }),
      );

      expect(error).toBeInstanceOf(EnvironmentNotLoadedError);
      expect((error as EnvironmentNotLoadedError).optionKey).toBe('url');
      expect((error as Error).message).toContain(`${part} part`);
      expect((error as Error).message).not.toContain(passwordSentinel);
      expect((error as Error).message).not.toContain(url);
    },
  );

  it('names the port first when a Buyon-style DataSource got no environment at all', async () => {
    const options = {
      type: 'postgres',
      host: undefined,
      port: Number(undefined),
      username: String(undefined),
      password: undefined,
      database: String(undefined),
    };

    await expect(resolveConnectionTarget(options)).rejects.toMatchObject({
      name: 'EnvironmentNotLoadedError',
      optionKey: 'port',
    });
  });

  it('names the first literal "undefined" when only strings are not loaded', async () => {
    const options = {
      type: 'postgres',
      host: undefined,
      port: 5432,
      username: String(undefined),
      database: String(undefined),
    };

    await expect(resolveConnectionTarget(options)).rejects.toMatchObject({
      name: 'EnvironmentNotLoadedError',
      optionKey: 'username',
    });
  });

  it('lets a valid url override discrete options that are not loaded', async () => {
    const target = await resolveTarget({
      type: 'postgres',
      url: 'postgres://u:p@h:5432/d',
      host: 'undefined',
      port: Number.NaN,
      username: 'undefined',
      database: 'undefined',
    });

    expect(describeTarget(target)).toBe('postgres://h:5432/d');
  });

  it('does not mistake real names that contain the word for a missing value', async () => {
    const target = await resolveTarget({
      type: 'postgres',
      host: 'undefined-host.test',
      username: 'undefined_user',
      database: 'undefined_db',
      port: '5433',
    });

    expect(target).toMatchObject({
      host: 'undefined-host.test',
      user: 'undefined_user',
      database: 'undefined_db',
      port: 5433,
    });
  });

  it('keeps unsupported types unsupported even when the options are not loaded', async () => {
    await expect(
      resolveConnectionTarget({
        type: 'mysql',
        host: 'undefined',
        port: Number.NaN,
      }),
    ).resolves.toEqual({ kind: 'unsupported', typeormType: 'mysql' });
  });

  it('reports a PGPORT that is not a number instead of returning NaN', async () => {
    vi.stubEnv('PGPORT', 'not-a-port');

    const error = await captureRejection(
      resolveConnectionTarget({ type: 'postgres', host: 'h', username: 'u' }),
    );

    expect((error as Error).message).toContain('PGPORT');
    expect((error as Error).message).not.toContain('not-a-port');
  });
});

describe('unsupported types', () => {
  it.each([
    'mysql',
    'mariadb',
    'sqlite',
    'better-sqlite3',
    'mssql',
    'oracle',
    'mongodb',
    'cockroachdb',
    'aurora-postgres',
    'aurora-mysql',
    'sqljs',
    'sap',
    'spanner',
    'expo',
  ])('returns unsupported for %s without throwing', async (type) => {
    await expect(resolveConnectionTarget({ type })).resolves.toEqual({
      kind: 'unsupported',
      typeormType: type,
    });
  });

  it.each([
    [undefined, 'undefined'],
    [null, 'object'],
    [5432, 'number'],
  ])('describes a type that is %s as "%s"', async (type, described) => {
    await expect(resolveConnectionTarget({ type })).resolves.toEqual({
      kind: 'unsupported',
      typeormType: described,
    });
  });
});

describe('resolving a target', () => {
  it('never mutates the options, even frozen ones with an ssl key', async () => {
    const options = deepFreeze({
      type: 'postgres',
      host: 'db.test',
      username: 'u',
      password: 'p',
      database: 'd',
      ssl: { rejectUnauthorized: true, ca: fakeCa, key: fakeKey },
      extra: { options: '-c search_path=app' },
    });
    const replicated = deepFreeze({
      type: 'postgres',
      replication: {
        master: {
          host: 'master.test',
          ssl: { rejectUnauthorized: false, key: fakeKey },
        },
        slaves: [],
      },
    });

    const target = await resolveTarget(options);
    const replicatedTarget = await resolveTarget(replicated);

    expect(target.tls).toEqual({
      rejectUnauthorized: true,
      ca: fakeCa,
      key: fakeKey,
    });
    expect(replicatedTarget.tls).toEqual({
      rejectUnauthorized: false,
      key: fakeKey,
    });
    expect(Object.keys(options.ssl)).toEqual([
      'rejectUnauthorized',
      'ca',
      'key',
    ]);
  });

  it('reads an ssl.key that pg already made non-enumerable', async () => {
    const ssl = { ca: fakeCa, key: fakeKey };
    Object.defineProperty(ssl, 'key', { enumerable: false });

    const target = await resolveTarget({ type: 'postgres', host: 'h', ssl });

    expect(target.tls).toEqual({
      rejectUnauthorized: true,
      ca: fakeCa,
      key: fakeKey,
    });
  });

  it('joins a list of CA certificates into one bundle', async () => {
    const target = await resolveTarget({
      type: 'postgres',
      host: 'h',
      ssl: { ca: [fakeCa, Buffer.from(fakeCert)] },
    });

    expect(target.tls).toEqual({
      rejectUnauthorized: true,
      ca: `${fakeCa}\n${fakeCert}`,
    });
  });

  it('turns rejectUnauthorized into a boolean only when it is set to false', async () => {
    const unset = await resolveTarget({
      type: 'postgres',
      host: 'h',
      ssl: { ca: fakeCa },
    });
    const explicitlyOff = await resolveTarget({
      type: 'postgres',
      host: 'h',
      ssl: { rejectUnauthorized: false },
    });
    const undefinedValue = await resolveTarget({
      type: 'postgres',
      host: 'h',
      ssl: { rejectUnauthorized: undefined },
    });

    expect(unset.tls).toMatchObject({ rejectUnauthorized: true });
    expect(explicitlyOff.tls).toEqual({ rejectUnauthorized: false });
    expect(undefinedValue.tls).toEqual({ rejectUnauthorized: true });
  });

  it('follows NODE_TLS_REJECT_UNAUTHORIZED=0 only while rejectUnauthorized is unset', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');

    const unset = await resolveTarget({
      type: 'postgres',
      host: 'h',
      ssl: true,
    });
    const explicit = await resolveTarget({
      type: 'postgres',
      host: 'h',
      ssl: { rejectUnauthorized: true },
    });

    expect(unset.tls).toEqual({ rejectUnauthorized: false });
    expect(explicit.tls).toEqual({ rejectUnauthorized: true });
  });

  it('calls a function password once, with the connection parameters, and keeps the string', async () => {
    const supplier = vi.fn(async () => 'once-pw-0009');

    const target = await resolveTarget({
      type: 'postgres',
      host: 'db.test',
      username: 'u',
      database: 'd',
      password: supplier,
    });

    expect(target.password).toBe('once-pw-0009');
    expect(supplier).toHaveBeenCalledTimes(1);
    expect(supplier).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'db.test', user: 'u', database: 'd' }),
    );
  });

  it('rejects a function password that throws without echoing its message', async () => {
    const error = await captureRejection(
      resolveConnectionTarget({
        type: 'postgres',
        host: 'h',
        password: () => {
          throw new RangeError(`token ${passwordSentinel} expired`);
        },
      }),
    );

    expect((error as Error).message).toContain('"password"');
    expect((error as Error).message).toContain('RangeError');
    expect((error as Error).message).not.toContain(passwordSentinel);
  });

  it.each([
    ['a function returning a number', () => 12345],
    ['a function returning null', () => null],
    ['a number', 12345],
    ['an object', { value: passwordSentinel }],
  ])('rejects a password that is %s', async (_label, password) => {
    const error = await captureRejection(
      resolveConnectionTarget({ type: 'postgres', host: 'h', password }),
    );

    expect((error as Error).message).toContain('"password"');
    expect((error as Error).message).not.toContain(passwordSentinel);
  });

  it('treats a function password that returns undefined as no password', async () => {
    const target = await resolveTarget({
      type: 'postgres',
      host: 'h',
      password: () => undefined,
    });

    expect(target.password).toBeUndefined();
  });

  it('does not echo an unparsable url in the error', async () => {
    const error = await captureRejection(
      resolveConnectionTarget({
        type: 'postgres',
        url: `postgres://app:${passwordSentinel}@h:not-a-port/d`,
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('ERR_INVALID_URL');
    expect((error as Error).message).not.toContain(passwordSentinel);
  });

  it('reports an empty user and database when pg has nothing to fall back to', async () => {
    const original = defaults.user;
    defaults.user = undefined;
    try {
      const target = await resolveTarget({ type: 'postgres', host: 'h' });

      expect(target.user).toBe('');
      expect(target.database).toBe('');
    } finally {
      defaults.user = original;
    }
  });
});

describe('warnings', () => {
  it('is empty for a plain configuration', async () => {
    const resolved = await resolveConnectionTarget({
      type: 'postgres',
      host: 'h',
      ssl: { rejectUnauthorized: false, ca: fakeCa },
      extra: { max: 5, statement_timeout: 1000 },
    });

    expect(resolved).toMatchObject({ kind: 'target', warnings: [] });
  });

  it('names the ssl keys that cannot be represented, never their values', async () => {
    const resolved = await resolveConnectionTarget({
      type: 'postgres',
      host: 'h',
      ssl: {
        checkServerIdentity: () => undefined,
        pfx: passwordSentinel,
        minVersion: 'TLSv1.2',
        cert: { pem: passwordSentinel },
        ca: undefined,
      },
    });

    expect(resolved).toMatchObject({
      kind: 'target',
      warnings: [
        'ssl.checkServerIdentity',
        'ssl.pfx',
        'ssl.minVersion',
        'ssl.cert',
      ],
    });
    expect(JSON.stringify(resolved)).not.toContain(passwordSentinel);
  });

  it('names checkServerIdentity set by a libpq-compatible sslmode in the url', async () => {
    const caFile = path.join(scratchDirectory, 'root-ca.pem');
    writeFileSync(caFile, fakeCa);

    const resolved = await resolveConnectionTarget({
      type: 'postgres',
      url: `postgres://u:p@h:5432/d?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=${encodeURIComponent(caFile)}`,
    });

    expect(resolved).toMatchObject({
      kind: 'target',
      warnings: ['ssl.checkServerIdentity'],
    });
    expect(resolved.kind === 'target' && resolved.target.tls).toEqual({
      rejectUnauthorized: true,
      ca: fakeCa,
    });
  });

  it('reports an unreadable sslrootcert by error code only', async () => {
    const missing = path.join(scratchDirectory, 'missing-ca.pem');

    const error = await captureRejection(
      resolveConnectionTarget({
        type: 'postgres',
        url: `postgres://u:${passwordSentinel}@h:5432/d?sslmode=require&sslrootcert=${encodeURIComponent(missing)}`,
      }),
    );

    expect((error as Error).message).toContain('ENOENT');
    expect((error as Error).message).not.toContain(passwordSentinel);
    expect((error as Error).message).not.toContain(missing);
  });

  it('names options that change the connection and cannot be forwarded', async () => {
    const streamFactory = vi.fn(() => undefined);

    const resolved = await resolveConnectionTarget({
      type: 'postgres',
      host: 'h',
      driver: {},
      nativeDriver: {},
      extra: {
        stream: streamFactory,
        Client: class {},
        sslnegotiation: 'direct',
        ssl: true,
      },
    });

    expect(resolved).toMatchObject({
      kind: 'target',
      warnings: [
        'extra.stream',
        'extra.Client',
        'driver',
        'nativeDriver',
        'sslnegotiation',
      ],
    });
    expect(streamFactory).not.toHaveBeenCalled();
  });
});

describe('makeTargetReadOnly', () => {
  it('sets the read-only option when there are no startup options', () => {
    expect(makeTargetReadOnly(baseTarget).startupOptions).toBe(
      '-c default_transaction_read_only=on',
    );
  });

  it('appends to the startup options already there', () => {
    const target = { ...baseTarget, startupOptions: '-c search_path=app' };

    expect(makeTargetReadOnly(target).startupOptions).toBe(
      '-c search_path=app -c default_transaction_read_only=on',
    );
  });

  it('is idempotent and leaves every other field and the input untouched', () => {
    const once = makeTargetReadOnly(baseTarget);
    const twice = makeTargetReadOnly(once);

    expect(twice).toEqual(once);
    expect({ ...once, startupOptions: undefined }).toEqual(baseTarget);
    expect(baseTarget.startupOptions).toBeUndefined();
  });

  it('reaches pg as the options startup parameter', () => {
    const config = toPgClientConfig(makeTargetReadOnly(baseTarget));
    const parameters = readPgParameters({ ...config });

    expect(parameters.options).toBe('-c default_transaction_read_only=on');
  });
});

describe('describeTarget', () => {
  it('prints host, port and database', () => {
    expect(describeTarget(baseTarget)).toBe('postgres://db.test:5433/appdb');
  });

  it('prints a unix socket host as is', () => {
    const target = { ...baseTarget, host: '/var/run/postgresql', port: 5432 };

    expect(describeTarget(target)).toBe(
      'postgres:///var/run/postgresql:5432/appdb',
    );
  });

  it('brackets an ipv6 host', () => {
    expect(describeTarget({ ...baseTarget, host: '::1' })).toBe(
      'postgres://[::1]:5433/appdb',
    );
  });

  it.each([
    ['a tcp host', baseTarget],
    ['a unix socket host', { ...baseTarget, host: '/var/run/postgresql' }],
    [
      'a tls target with a key',
      {
        ...baseTarget,
        tls: {
          rejectUnauthorized: true,
          key: fakeKey,
          passphrase: passwordSentinel,
        },
      },
    ],
  ])('never contains the user or the password for %s', (_label, target) => {
    const described = describeTarget(target);

    expect(described).not.toContain(passwordSentinel);
    expect(described).not.toContain(target.user);
    expect(described).not.toContain('FAKE-KEY');
  });
});

describe('toPgClientConfig', () => {
  it('maps every target field to its pg name', () => {
    const target: ConnectionTarget = {
      ...baseTarget,
      applicationName: 'billing-api',
      startupOptions: '-c search_path=app',
      tls: { rejectUnauthorized: false, ca: fakeCa },
    };

    expect(toPgClientConfig(target)).toEqual({
      host: 'db.test',
      port: 5433,
      user: 'app_user',
      password: passwordSentinel,
      database: 'appdb',
      ssl: { rejectUnauthorized: false, ca: fakeCa },
      application_name: 'billing-api',
      options: '-c search_path=app',
    });
  });

  it('turns a missing tls setting into an explicit ssl: false', () => {
    expect(toPgClientConfig(baseTarget).ssl).toBe(false);
  });

  it('hands pg a copy of the tls settings so the target survives pg redefining ssl.key', () => {
    const target: ConnectionTarget = {
      ...baseTarget,
      tls: { rejectUnauthorized: true, key: fakeKey },
    };

    const config = toPgClientConfig(target);
    new Client(config);

    expect(config.ssl).not.toBe(target.tls);
    expect(Object.keys(target.tls)).toEqual(['rejectUnauthorized', 'key']);
  });

  it.each(goldenCases.filter((goldenCase) => !goldenCase.env))(
    'round-trips through pg connectionParameters: $name',
    async (goldenCase) => {
      const target = await resolveTarget({
        type: 'postgres',
        ...goldenCase.options,
      });

      const pg = readPgParameters({ ...toPgClientConfig(target) });

      expect(pg.host).toBe(target.host);
      expect(pg.port).toBe(target.port);
      expect(pg.user).toBe(target.user);
      expect(pg.database).toBe(target.database);
      expect(pg.password ?? undefined).toBe(target.password);
      expect(pg.application_name).toBe(target.applicationName);
      expect(pg.options).toBe(target.startupOptions);
      expect(Boolean(pg.ssl)).toBe(target.tls !== false);
    },
  );

  it('does not let the environment of the process using the config change an explicit ssl', () => {
    vi.stubEnv('PGSSLMODE', 'require');

    const pg = readPgParameters({ ...toPgClientConfig(baseTarget) });

    expect(pg.ssl).toBe(false);
  });
});
