import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  composeApplicationEnvironment,
  locateProject,
} from '../../src/typeorm/locate-project.ts';
import {
  maskSecrets,
  readConnectionTarget,
} from '../../src/typeorm/read-connection-target.ts';
import type {
  ReaderFailure,
  ReadOutcome,
} from '../../src/typeorm/read-connection-target.ts';
import type { ConnectionTarget } from '../../src/typeorm/resolve-connection-target.ts';

const execFileAsync = promisify(execFile);

const fixturesDirectory = fileURLToPath(
  new URL('../fixtures/', import.meta.url),
);
const casesDirectory = path.join(fixturesDirectory, 'loader-cases');
const readerTimeoutMs = 20_000;
const readerApiUrl = new URL(
  '../../src/typeorm/read-connection-target.ts',
  import.meta.url,
).href;

type FixtureProject = {
  readonly name: string;
  readonly directory: string;
  readonly datasourceFile: string;
  readonly shellOverride: Readonly<Record<string, string>>;
  readonly overriddenPort: number;
  readonly expected: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly database: string;
    readonly applicationName: string | undefined;
  };
  readonly password: string;
};

const fixtureProjects: readonly FixtureProject[] = [
  {
    name: 'ESM Nest project',
    directory: 'esm-nest-project',
    datasourceFile: 'src/config/database/postgres.data-source.ts',
    shellOverride: { POSTGRES_PORT: '55999' },
    overriddenPort: 55999,
    expected: {
      host: '127.0.0.1',
      port: 55432,
      user: 'fixture_user',
      database: 'fixture_esm_db',
      applicationName: 'fixture-api-test',
    },
    password: 'fixture-password-esm-7f3a91',
  },
  {
    name: 'CJS Nest project',
    directory: 'cjs-nest-project',
    datasourceFile: 'src/config/db/postgres/fixture-datasource.ts',
    shellOverride: { FIXTURE_DB_PORT: '55998' },
    overriddenPort: 55998,
    expected: {
      host: '127.0.0.1',
      port: 55433,
      user: 'fixture_user',
      database: 'fixture_cjs_db',
      applicationName: undefined,
    },
    password: 'fixture-password-cjs-4c82d0',
  },
];

type TargetCase = {
  readonly caseName: string;
  readonly datasourceName: string;
  readonly explains: string;
  readonly expected: {
    readonly port: number;
    readonly database: string;
    readonly applicationName: string | undefined;
  };
  readonly password: string;
};

const targetCases: readonly TargetCase[] = [
  {
    caseName: 'options-object-export',
    datasourceName: 'datasource.js',
    explains: 'a DataSourceOptions object exported by name',
    expected: {
      port: 55501,
      database: 'case_options_db',
      applicationName: undefined,
    },
    password: 'case-password-options-5521',
  },
  {
    caseName: 'default-factory',
    datasourceName: 'datasource.js',
    explains: 'an async default factory that is called exactly once',
    expected: {
      port: 55502,
      database: 'case_factory_db',
      applicationName: 'factory-call-1',
    },
    password: 'case-password-factory-2290',
  },
  {
    caseName: 'default-factory-options',
    datasourceName: 'datasource.js',
    explains: 'a default factory that returns plain options',
    expected: {
      port: 55503,
      database: 'case_factory_options_db',
      applicationName: undefined,
    },
    password: 'case-password-factory-options-6407',
  },
  {
    caseName: 'aliased-datasource',
    datasourceName: 'datasource.js',
    explains: 'one instance exported under two names',
    expected: {
      port: 55506,
      database: 'case_aliased_db',
      applicationName: undefined,
    },
    password: 'case-password-aliased-7741',
  },
  {
    caseName: 'cjs-module-exports-instance',
    datasourceName: 'datasource.js',
    explains: 'a CommonJS module that is itself the DataSource',
    expected: {
      port: 55511,
      database: 'case_cjs_instance_db',
      applicationName: undefined,
    },
    password: 'case-password-cjs-instance-8826',
  },
  {
    caseName: 'cjs-module-exports-options',
    datasourceName: 'ormconfig.js',
    explains: 'an ormconfig.js that exports the options object itself',
    expected: {
      port: 55512,
      database: 'case_cjs_options_db',
      applicationName: undefined,
    },
    password: 'case-password-cjs-options-4419',
  },
  {
    caseName: 'esm-wraps-cjs-build',
    datasourceName: 'datasource.js',
    explains:
      'an ESM file re-exporting a CommonJS build ({ default: { default } })',
    expected: {
      port: 55513,
      database: 'case_wrapped_db',
      applicationName: undefined,
    },
    password: 'case-password-wrapped-9253',
  },
  {
    caseName: 'export-promise-datasource',
    datasourceName: 'datasource.js',
    explains: 'a Promise<DataSource> export',
    expected: {
      port: 55514,
      database: 'case_promise_db',
      applicationName: undefined,
    },
    password: 'case-password-promise-1376',
  },
  {
    caseName: 'extension-mts',
    datasourceName: 'datasource.mts',
    explains: 'a .mts file in a package without "type" (still ESM)',
    expected: {
      port: 55515,
      database: 'case_mts_db',
      applicationName: 'esm-string',
    },
    password: 'case-password-mts-6630',
  },
  {
    caseName: 'extension-cts',
    datasourceName: 'datasource.cts',
    explains: 'a .cts file in a "type": "module" package (still CommonJS)',
    expected: {
      port: 55516,
      database: 'extension-cts',
      applicationName: undefined,
    },
    password: 'case-password-cts-2085',
  },
  {
    caseName: 'legacy-typeorm',
    datasourceName: 'datasource.js',
    explains: 'a DataSource built by TypeORM 0.3.x',
    expected: {
      port: 55517,
      database: 'case_legacy_db',
      applicationName: undefined,
    },
    password: 'case-password-legacy-0764',
  },
];

function readLoaderCase(options: {
  readonly caseName: string;
  readonly datasourceName?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}): Promise<ReadOutcome> {
  const packageDir = path.join(casesDirectory, options.caseName);
  return readConnectionTarget({
    location: {
      datasourceFile: path.join(
        packageDir,
        options.datasourceName ?? 'datasource.js',
      ),
      packageDir,
      workspaceRoot: packageDir,
      foundBy: 'loader case',
      envFiles: [],
    },
    applicationEnvironment: options.environment ?? {},
    timeoutMs: options.timeoutMs ?? readerTimeoutMs,
  });
}

type TargetOutcome = Extract<ReadOutcome, { readonly kind: 'target' }>;

function requireTargetOutcome(outcome: ReadOutcome): TargetOutcome {
  if (outcome.kind === 'target') return outcome;
  const detail =
    outcome.kind === 'failed' ? ` (${outcome.failure.reason})` : '';
  throw new Error(`expected a target outcome, got ${outcome.kind}${detail}`);
}

function requireTarget(outcome: ReadOutcome): ConnectionTarget {
  return requireTargetOutcome(outcome).target;
}

function requireFailure(outcome: ReadOutcome): ReaderFailure {
  if (outcome.kind === 'failed') return outcome.failure;
  throw new Error(`expected a failed outcome, got ${outcome.kind}`);
}

// The password is compared as a boolean and left out of every diff, so that a
// failing assertion never prints it.
function hasPassword(target: ConnectionTarget, expected: string): boolean {
  return target.password === expected;
}

function omitPassword(
  target: ConnectionTarget,
): Omit<ConnectionTarget, 'password'> {
  const { password: _password, ...withoutPassword } = target;
  return withoutPassword;
}

async function countProcessesMentioning(needle: string): Promise<number> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'args=']);
  return stdout.split('\n').filter((line) => line.includes(needle)).length;
}

describe('readConnectionTarget on the fixture projects', () => {
  it.each(fixtureProjects)(
    'reads the target of the $name located the way the CLI does, in under 2 s',
    async (fixture) => {
      const projectDir = path.join(fixturesDirectory, fixture.directory);
      const location = locateProject({
        startDir: projectDir,
        explicitDatasourceFile: undefined,
        explicitEnvFiles: [],
      });
      const applicationEnvironment = composeApplicationEnvironment({
        envFiles: location.envFiles,
        shellEnv: {},
      });

      const startedAt = performance.now();
      const outcome = await readConnectionTarget({
        location,
        applicationEnvironment,
        timeoutMs: readerTimeoutMs,
      });
      const elapsedMs = performance.now() - startedAt;

      const { target, warnings } = requireTargetOutcome(outcome);
      expect(path.relative(projectDir, location.datasourceFile)).toBe(
        fixture.datasourceFile,
      );
      expect(omitPassword(target)).toMatchObject({
        dialect: 'postgres',
        typeormType: 'postgres',
        ...fixture.expected,
        tls: false,
      });
      expect(hasPassword(target, fixture.password)).toBe(true);
      expect(warnings).toEqual([]);
      expect(elapsedMs).toBeLessThan(2_000);
    },
  );

  it.each(fixtureProjects)(
    'reads the $name when the project loads its own .env and the CLI passes nothing',
    async (fixture) => {
      const projectDir = path.join(fixturesDirectory, fixture.directory);
      const outcome = await readConnectionTarget({
        location: locateProject({
          startDir: projectDir,
          explicitDatasourceFile: undefined,
          explicitEnvFiles: [],
        }),
        applicationEnvironment: {},
        timeoutMs: readerTimeoutMs,
      });

      const target = requireTarget(outcome);
      expect(omitPassword(target)).toMatchObject(fixture.expected);
      expect(hasPassword(target, fixture.password)).toBe(true);
    },
  );

  it.each(fixtureProjects)(
    'lets a variable from the shell win over the .env of the $name',
    async (fixture) => {
      const projectDir = path.join(fixturesDirectory, fixture.directory);
      const location = locateProject({
        startDir: projectDir,
        explicitDatasourceFile: undefined,
        explicitEnvFiles: [],
      });

      const outcome = await readConnectionTarget({
        location,
        applicationEnvironment: composeApplicationEnvironment({
          envFiles: location.envFiles,
          shellEnv: fixture.shellOverride,
        }),
        timeoutMs: readerTimeoutMs,
      });

      expect(requireTarget(outcome).port).toBe(fixture.overriddenPort);
    },
  );
});

describe('readConnectionTarget on loader cases', () => {
  it.each(targetCases)('reads $explains', async (targetCase) => {
    const outcome = await readLoaderCase(targetCase);

    const target = requireTarget(outcome);
    expect(omitPassword(target)).toMatchObject({
      host: '127.0.0.1',
      user: 'case_user',
      ...targetCase.expected,
    });
    expect(hasPassword(target, targetCase.password)).toBe(true);
  });

  it('refuses a file that exports several DataSources and names the exports', async () => {
    const outcome = await readLoaderCase({ caseName: 'two-datasources' });

    expect(outcome).toEqual({
      kind: 'failed',
      failure: {
        reason: 'several-datasources',
        exportNames: ['primary', 'replica'],
      },
    });
  });

  it('lists what a file exports when none of it is a DataSource', async () => {
    const outcome = await readLoaderCase({ caseName: 'no-datasource-export' });

    expect(outcome).toEqual({
      kind: 'failed',
      failure: {
        reason: 'no-datasource-export',
        exportNames: ['helper', 'helperName'],
      },
    });
  });

  it.each(['default-class-export', 'default-function-with-arguments'])(
    'never runs a default export that is not a zero-argument factory (%s)',
    async (caseName) => {
      const outcome = await readLoaderCase({ caseName });

      expect(outcome).toEqual({
        kind: 'failed',
        failure: { reason: 'no-datasource-export', exportNames: ['default'] },
      });
    },
  );

  it('names the package that cannot be resolved', async () => {
    const outcome = await readLoaderCase({ caseName: 'missing-package' });

    expect(outcome).toEqual({
      kind: 'failed',
      failure: {
        reason: 'module-not-found',
        specifier: 'fixture-package-that-is-not-installed',
      },
    });
  });

  it('names the relative file that cannot be resolved', async () => {
    const outcome = await readLoaderCase({
      caseName: 'missing-relative-file',
    });

    const failure = requireFailure(outcome);
    expect(failure.reason).toBe('module-not-found');
    expect(failure.reason === 'module-not-found' && failure.specifier).toBe(
      path.join(casesDirectory, 'missing-relative-file', 'not-here.js'),
    );
  });

  it('reports a database type other than postgres as unsupported', async () => {
    const outcome = await readLoaderCase({ caseName: 'non-postgres' });

    expect(outcome).toEqual({ kind: 'unsupported', typeormType: 'mysql' });
  });

  it('reports the option key when the environment was not loaded', async () => {
    const outcome = await readLoaderCase({ caseName: 'unloaded-environment' });

    expect(outcome).toEqual({
      kind: 'failed',
      failure: { reason: 'environment-not-loaded', optionKey: 'port' },
    });
  });
});

describe('readConnectionTarget and the database', () => {
  it('never opens a connection to the database it reads the target of', async () => {
    let connectionCount = 0;
    const listener = net.createServer(() => {
      connectionCount += 1;
    });
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = listener.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected the listener to have a TCP address');
      }

      const outcome = await readLoaderCase({
        caseName: 'unloaded-environment',
        environment: {
          CASE_DB_HOST: '127.0.0.1',
          CASE_DB_PORT: String(address.port),
          CASE_DB_USER: 'case_user',
          CASE_DB_SECRET: 'case-secret-listener-6150',
          CASE_DB_NAME: 'case_listener_db',
        },
      });

      // A connection would have been made before the reader answered; the pause only
      // lets the listener see it.
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(requireTarget(outcome).port).toBe(address.port);
      expect(connectionCount).toBe(0);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});

describe('readConnectionTarget when the project misbehaves', () => {
  it('reports process.exit as a failure and leaves no process behind', async () => {
    const datasourceFile = path.join(
      casesDirectory,
      'process-exit',
      'datasource.js',
    );

    const outcome = await readLoaderCase({ caseName: 'process-exit' });

    expect(outcome).toEqual({
      kind: 'failed',
      failure: { reason: 'process-exit', exitCode: 1 },
    });
    expect(await countProcessesMentioning(datasourceFile)).toBe(0);
  });

  it('still reports process.exit when the project swallows the error it throws', async () => {
    const outcome = await readLoaderCase({
      caseName: 'process-exit-swallowed',
    });

    expect(outcome).toEqual({
      kind: 'failed',
      failure: { reason: 'process-exit', exitCode: 3 },
    });
    expect(JSON.stringify(outcome)).not.toContain(
      'case-password-swallowed-1180',
    );
  });

  it('keeps only the key names of an environment validation error', async () => {
    const outcome = await readLoaderCase({
      caseName: 'zod-missing-keys',
      environment: {
        CASE_DB_PORT: 'sentinel-port-3307',
        CASE_DB_LABEL: 'sentinel-label-8812',
      },
    });

    expect(outcome).toEqual({
      kind: 'failed',
      failure: {
        reason: 'invalid-environment',
        keyNames: ['CASE_DB_HOST', 'CASE_DB_PORT', 'CASE_DB_LABEL'],
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/sentinel/);
  });

  it('masks secrets in the message of any other import error', async () => {
    const outcome = await readLoaderCase({
      caseName: 'import-error',
      environment: { CASE_API_TOKEN: 'case-token-value-77281' },
    });

    expect(outcome).toEqual({
      kind: 'failed',
      failure: {
        reason: 'import-error',
        errorName: 'Error',
        errorCode: 'E_CASE_FAILURE',
        message:
          'cannot reach *** through postgres://***@db.example.test:5432/app',
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(
      /case-token-value|case-url-password|CASE_SECOND_LINE_MARKER/,
    );
  });

  it('masks secrets in the output tail of a reader that died', async () => {
    const outcome = await readLoaderCase({
      caseName: 'reader-crash',
      environment: { CASE_API_TOKEN: 'case-token-value-77281' },
    });

    const failure = requireFailure(outcome);
    expect(failure).toMatchObject({ reason: 'reader-crashed', exitCode: null });
    expect(failure.reason === 'reader-crashed' && failure.outputTail).toContain(
      'fixture crash: token=*** url=postgres://***@db.example.test/app\n',
    );
    expect(JSON.stringify(outcome)).not.toMatch(
      /case-token-value|case-url-password/,
    );
  });

  it('gives up on a reader that never finishes and leaves no process behind', async () => {
    const datasourceFile = path.join(
      casesDirectory,
      'hangs-forever',
      'datasource.js',
    );

    const pending = readLoaderCase({
      caseName: 'hangs-forever',
      timeoutMs: 2_000,
    });
    await vi.waitFor(
      async () => {
        expect(await countProcessesMentioning(datasourceFile)).toBeGreaterThan(
          0,
        );
      },
      { timeout: 1_500, interval: 50 },
    );
    const outcome = await pending;

    expect(requireFailure(outcome).reason).toBe('reader-timed-out');
    expect(await countProcessesMentioning(datasourceFile)).toBe(0);
  });
});

describe('readConnectionTarget when loading ends in an unusual way', () => {
  it('reports a load that can never finish instead of a bare exit code', async () => {
    const outcome = await readLoaderCase({ caseName: 'unsettled-import' });

    expect(outcome).toMatchObject({
      kind: 'failed',
      failure: { reason: 'import-error', errorName: 'UnsettledLoad' },
    });
  });

  it('reports a process.exit that the project schedules for later', async () => {
    const outcome = await readLoaderCase({ caseName: 'process-exit-async' });

    expect(outcome).toEqual({
      kind: 'failed',
      failure: { reason: 'process-exit', exitCode: 4 },
    });
  });

  it('reports an error that escapes from a background promise while loading', async () => {
    const outcome = await readLoaderCase({ caseName: 'uncaught-error' });

    expect(outcome).toMatchObject({
      kind: 'failed',
      failure: {
        reason: 'import-error',
        errorName: 'Error',
        message: 'background connection refused',
      },
    });
  });

  it('lets the reader exit by itself when its parent dies without cleaning up', async () => {
    const datasourceFile = path.join(
      casesDirectory,
      'hangs-forever',
      'datasource.js',
    );
    const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typeorm-studio-'));
    try {
      const runnerFile = path.join(runnerDir, 'killed-parent.mjs');
      fs.writeFileSync(
        runnerFile,
        `
        import { readConnectionTarget } from ${JSON.stringify(readerApiUrl)};

        await readConnectionTarget({
          location: {
            datasourceFile: ${JSON.stringify(datasourceFile)},
            packageDir: ${JSON.stringify(path.dirname(datasourceFile))},
            workspaceRoot: ${JSON.stringify(path.dirname(datasourceFile))},
            foundBy: 'killed parent',
            envFiles: [],
          },
          applicationEnvironment: {},
          timeoutMs: 120_000,
        });
        `,
      );
      const parent = spawn(process.execPath, [runnerFile], { stdio: 'ignore' });
      await vi.waitFor(
        async () => {
          expect(
            await countProcessesMentioning(datasourceFile),
          ).toBeGreaterThan(0);
        },
        { timeout: 5_000, interval: 50 },
      );

      parent.kill('SIGKILL');

      await vi.waitFor(
        async () => {
          expect(await countProcessesMentioning(datasourceFile)).toBe(0);
        },
        { timeout: 5_000, interval: 50 },
      );
    } finally {
      fs.rmSync(runnerDir, { recursive: true, force: true });
    }
  });
});

describe('readConnectionTarget environment handed to the project', () => {
  it('passes PORT and NODE_ENV untouched, marks the run, and drops NODE_OPTIONS', async () => {
    const outcome = await readLoaderCase({
      caseName: 'environment-probe',
      environment: {
        NODE_ENV: 'production',
        PORT: '8080',
        NODE_OPTIONS: '--require /nonexistent/preload-that-would-crash.cjs',
        CASE_PASSTHROUGH: 'kept',
        DOTENV_CONFIG_QUIET: 'false',
      },
    });

    expect(requireTarget(outcome).applicationName).toBe(
      'production|8080|1|true|unset|kept',
    );
  });
});

describe('maskSecrets', () => {
  const environment = {
    DB_PASSWORD: 'masked-password-4821',
    API_SECRET: 'masked-secret-7733',
    SERVICE_TOKEN: 'masked-token-1290',
    S3_ACCESS_KEY: 'masked-key-5564',
    CLOUD_CREDENTIALS: 'masked-credentials-8802',
    SIGNING_PRIVATE_PEM: 'masked-private-3095',
    PORT: '3000',
    LOG_LEVEL: 'debug',
    SHORT_SECRET: 'abc',
    UNSET_TOKEN: undefined,
  };

  it('hides the value of every variable whose name looks secret', () => {
    const text = [
      environment.DB_PASSWORD,
      environment.API_SECRET,
      environment.SERVICE_TOKEN,
      environment.S3_ACCESS_KEY,
      environment.CLOUD_CREDENTIALS,
      environment.SIGNING_PRIVATE_PEM,
    ].join(' | ');

    expect(maskSecrets(text, environment)).toBe(
      '*** | *** | *** | *** | *** | ***',
    );
  });

  it('keeps ordinary values and values too short to be worth hiding', () => {
    const text = 'port 3000 level debug abc';

    expect(maskSecrets(text, environment)).toBe(text);
  });

  it('hides a secret that contains another secret as a whole', () => {
    const nested = {
      INNER_TOKEN: 'inner-value-1111',
      OUTER_SECRET: 'inner-value-1111-and-more',
    };

    expect(maskSecrets('seen inner-value-1111-and-more', nested)).toBe(
      'seen ***',
    );
  });

  it('stays fast on a long output without any URL in it', () => {
    const longOutput = 'a'.repeat(64 * 1024);

    const startedAt = performance.now();
    const masked = maskSecrets(longOutput, environment);
    const elapsedMs = performance.now() - startedAt;

    expect(masked).toBe(longOutput);
    expect(elapsedMs).toBeLessThan(500);
  });

  it('hides the credentials inside URLs and keeps the rest of them', () => {
    expect(
      maskSecrets(
        'postgres://app:hunter2-pass@db.example.test:5432/app and https://example.test:8080/path?x=a@b and redis://:only-pass@cache.example.test',
        {},
      ),
    ).toBe(
      'postgres://***@db.example.test:5432/app and https://example.test:8080/path?x=a@b and redis://***@cache.example.test',
    );
  });
});
