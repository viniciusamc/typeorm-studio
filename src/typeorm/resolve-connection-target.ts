import { isIPv6 } from 'node:net';
import { Client } from 'pg';
import type { ClientConfig } from 'pg';

export type PostgresTls =
  | false
  | {
      readonly rejectUnauthorized: boolean;
      readonly ca?: string;
      readonly cert?: string;
      readonly key?: string;
      readonly passphrase?: string;
      readonly servername?: string;
    };

export type ConnectionTarget = {
  readonly dialect: 'postgres';
  readonly typeormType: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string | undefined;
  readonly database: string;
  readonly tls: PostgresTls;
  readonly applicationName: string | undefined;
  readonly startupOptions: string | undefined;
};

export type ResolvedConnection =
  | {
      readonly kind: 'target';
      readonly target: ConnectionTarget;
      readonly warnings: readonly string[];
    }
  | { readonly kind: 'unsupported'; readonly typeormType: string };

export class EnvironmentNotLoadedError extends Error {
  readonly optionKey: string;

  constructor(optionKey: string, found: string, expected: string) {
    super(
      `TypeORM option "${optionKey}" is ${found} but expected ${expected}; the environment it reads was not loaded before the DataSource options were built`,
    );
    this.name = 'EnvironmentNotLoadedError';
    this.optionKey = optionKey;
  }
}

type PgConnectionParameters = {
  readonly host: string;
  readonly port: number;
  readonly user: string | undefined;
  readonly database: string | undefined;
  readonly password: unknown;
  readonly ssl: unknown;
  readonly application_name: string | undefined;
  readonly options: string | undefined;
  readonly sslnegotiation: unknown;
};

type TlsMaterial = Partial<
  Record<'ca' | 'cert' | 'key' | 'passphrase' | 'servername', string>
>;

const tlsMaterialNames = [
  'ca',
  'cert',
  'key',
  'passphrase',
  'servername',
] as const;

export async function resolveConnectionTarget(
  typeormOptions: Readonly<Record<string, unknown>>,
): Promise<ResolvedConnection> {
  const rawType = typeormOptions.type;
  if (rawType !== 'postgres') {
    return {
      kind: 'unsupported',
      typeormType: typeof rawType === 'string' ? rawType : typeof rawType,
    };
  }

  const literal = buildPgClientLiteral(typeormOptions);
  assertEnvironmentLoaded(literal);
  const parameters = readPgConnectionParameters(literal);
  if (!Number.isInteger(parameters.port)) {
    throw new Error(
      `pg resolved port ${parameters.port} but expected an integer such as 5432; check TypeORM option "port" and the PGPORT environment variable`,
    );
  }
  const password = await resolvePasswordOnce(parameters);
  const tls = readTlsSettings(parameters.ssl);

  return {
    kind: 'target',
    target: {
      dialect: 'postgres',
      typeormType: 'postgres',
      host: parameters.host,
      port: parameters.port,
      user: parameters.user ?? '',
      password,
      database: parameters.database ?? '',
      tls: tls.tls,
      applicationName: parameters.application_name,
      startupOptions: parameters.options,
    },
    warnings: listUnrepresentableSettings(
      typeormOptions,
      parameters.sslnegotiation,
      tls.unrepresentableTlsKeys,
    ),
  };
}

export function makeTargetReadOnly(target: ConnectionTarget): ConnectionTarget {
  const readOnlyOption = '-c default_transaction_read_only=on';
  if (target.startupOptions?.includes(readOnlyOption)) return target;
  return {
    ...target,
    startupOptions: target.startupOptions
      ? `${target.startupOptions} ${readOnlyOption}`
      : readOnlyOption,
  };
}

export function describeTarget(target: ConnectionTarget): string {
  const host = isIPv6(target.host) ? `[${target.host}]` : target.host;
  return `postgres://${host}:${target.port}/${target.database}`;
}

export function toPgClientConfig(target: ConnectionTarget): ClientConfig {
  return {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    ssl: target.tls === false ? false : { ...target.tls },
    application_name: target.applicationName,
    options: target.startupOptions,
  };
}

// Mirrors PostgresDriver.createPool of typeorm 1.1.x and 0.3.30, keeping only the
// fields that decide where and how pg connects. `extra` is spread last, as there.
function buildPgClientLiteral(
  options: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const credentials = options.replication
    ? asRecord(asRecord(options.replication).master)
    : options;
  const merged: Record<string, unknown> = {
    connectionString: credentials.url,
    host: credentials.host,
    user: credentials.username,
    password: credentials.password,
    database: credentials.database,
    port: credentials.port,
    ssl: credentials.ssl,
    application_name: options.applicationName ?? credentials.applicationName,
    ...asRecord(options.extra),
  };
  return { ...merged, ssl: copySslSetting(merged.ssl) };
}

// pg redefines ssl.key on the object it receives, which throws on a frozen
// object and would silently mutate the caller's options otherwise.
function copySslSetting(ssl: unknown): unknown {
  if (typeof ssl !== 'object' || ssl === null) return ssl;
  const key: unknown = Reflect.get(ssl, 'key');
  return { ...ssl, key };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

// Runs on the TypeORM-side values because pg turns a NaN port into 5432 and
// rejects an "undefined" port in a URL with a bare "Invalid URL".
function assertEnvironmentLoaded(
  literal: Readonly<Record<string, unknown>>,
): void {
  if (literal.connectionString) {
    const unloadedPart =
      typeof literal.connectionString === 'string'
        ? findUnloadedUrlPart(literal.connectionString)
        : undefined;
    if (unloadedPart === undefined) return;
    throw new EnvironmentNotLoadedError(
      'url',
      `a URL whose ${unloadedPart} part is the string "undefined"`,
      'a postgres:// URL with every part filled in',
    );
  }

  const port = literal.port;
  if (isNaNPortValue(port)) {
    throw new EnvironmentNotLoadedError(
      'port',
      typeof port === 'string' ? `the string "${port}"` : 'NaN',
      'an integer such as 5432',
    );
  }

  const discreteOptions = [
    ['host', 'host', 'a hostname or a unix socket path'],
    ['user', 'username', 'a role name'],
    ['database', 'database', 'a database name'],
  ] as const;
  for (const [literalKey, optionKey, expected] of discreteOptions) {
    if (literal[literalKey] !== 'undefined') continue;
    throw new EnvironmentNotLoadedError(
      optionKey,
      'the string "undefined"',
      expected,
    );
  }
}

function findUnloadedUrlPart(connectionString: string): string | undefined {
  const parts =
    /^[a-z][a-z0-9+.-]*:\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?(\[[^\]]*\]|[^:/?#]*)(?::([^/?#]*))?(?:\/([^?#]*))?/i.exec(
      connectionString,
    );
  return ['user', 'password', 'host', 'port', 'database'].find(
    (_partName, index) => parts?.[index + 1] === 'undefined',
  );
}

function isNaNPortValue(port: unknown): boolean {
  if (typeof port === 'number') return Number.isNaN(port);
  if (typeof port === 'string') {
    return port !== '' && Number.isNaN(parseInt(port, 10));
  }
  return false;
}

function readPgConnectionParameters(
  literal: Readonly<Record<string, unknown>>,
): PgConnectionParameters {
  // pg calls a `stream` factory while constructing the client, which would run
  // user code that may open sockets; the target never uses it.
  const {
    stream: _stream,
    connection: _connection,
    ...constructible
  } = literal;
  let client: Client;
  try {
    client = new Client(constructible as ClientConfig);
  } catch (error) {
    // pg and pg-connection-string errors can carry the URL or file paths; keep
    // only the error identity.
    const name = error instanceof Error ? error.name : typeof error;
    const code =
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string'
        ? ` ${error.code}`
        : '';
    throw new Error(
      `pg rejected the connection options built from the TypeORM options (${name}${code}); expected "url" like postgres://user:password@host:5432/database, "ssl" as a boolean or TLS options and readable sslcert, sslkey and sslrootcert files`,
    );
  }
  const parameters: unknown = Reflect.get(client, 'connectionParameters');
  if (!isPgConnectionParameters(parameters)) {
    throw new Error(
      'pg Client has no connectionParameters with a string host and a numeric port; expected pg ~8.23',
    );
  }
  return parameters;
}

function isPgConnectionParameters(
  value: unknown,
): value is PgConnectionParameters {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'host') === 'string' &&
    typeof Reflect.get(value, 'port') === 'number'
  );
}

async function resolvePasswordOnce(
  parameters: PgConnectionParameters,
): Promise<string | undefined> {
  const password = parameters.password;
  if (typeof password === 'string') return password;
  if (password === undefined || password === null) return undefined;
  if (typeof password !== 'function') {
    throw new TypeError(
      `TypeORM option "password" is a ${typeof password} but expected a string or a function returning one`,
    );
  }

  let supplied: unknown;
  try {
    supplied = await (password as (connectionParameters: unknown) => unknown)(
      parameters,
    );
  } catch (error) {
    throw new Error(
      `TypeORM option "password" is a function that threw ${error instanceof Error ? error.name : typeof error} but expected it to return the password as a string`,
    );
  }
  if (supplied === undefined) return undefined;
  if (typeof supplied === 'string') return supplied;
  throw new TypeError(
    `TypeORM option "password" is a function that returned a ${typeof supplied} but expected a string`,
  );
}

function readTlsSettings(ssl: unknown): {
  readonly tls: PostgresTls;
  readonly unrepresentableTlsKeys: readonly string[];
} {
  if (!ssl) return { tls: false, unrepresentableTlsKeys: [] };

  // tls.connect flips its rejectUnauthorized default with this variable, so the
  // application does too.
  const verifyByDefault = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';
  if (typeof ssl !== 'object') {
    return {
      tls: { rejectUnauthorized: verifyByDefault },
      unrepresentableTlsKeys: [],
    };
  }

  const settings = ssl as Record<string, unknown>;
  const material = readTlsMaterial(settings);
  const rejectUnauthorized = Object.hasOwn(settings, 'rejectUnauthorized')
    ? settings.rejectUnauthorized !== false
    : verifyByDefault;
  const otherKeys = Object.keys(settings).filter(
    (name) =>
      settings[name] !== undefined &&
      name !== 'rejectUnauthorized' &&
      !tlsMaterialNames.some((materialName) => materialName === name),
  );
  return {
    tls: { rejectUnauthorized, ...material.texts },
    unrepresentableTlsKeys: [...otherKeys, ...material.unreadableKeys],
  };
}

function readTlsMaterial(settings: Readonly<Record<string, unknown>>): {
  readonly texts: TlsMaterial;
  readonly unreadableKeys: readonly string[];
} {
  const texts: TlsMaterial = {};
  const unreadableKeys: string[] = [];
  for (const name of tlsMaterialNames) {
    const raw = settings[name];
    if (raw === undefined) continue;
    const parts: readonly unknown[] =
      name === 'ca' && Array.isArray(raw) ? raw : [raw];
    if (parts.length === 0) continue;
    const decoded = parts.map(decodeTlsText);
    if (decoded.includes(undefined)) {
      unreadableKeys.push(name);
      continue;
    }
    texts[name] = decoded.join('\n');
  }
  return { texts, unreadableKeys };
}

function decodeTlsText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return undefined;
}

function listUnrepresentableSettings(
  typeormOptions: Readonly<Record<string, unknown>>,
  sslnegotiation: unknown,
  unrepresentableTlsKeys: readonly string[],
): readonly string[] {
  const extra = asRecord(typeormOptions.extra);
  const warnings = [
    ...unrepresentableTlsKeys.map((name) => `ssl.${name}`),
    ...['stream', 'Client']
      .filter((name) => extra[name] !== undefined)
      .map((name) => `extra.${name}`),
    ...['driver', 'nativeDriver'].filter(
      (name) => typeormOptions[name] !== undefined,
    ),
  ];
  if (sslnegotiation === 'direct') warnings.push('sslnegotiation');
  return warnings;
}
