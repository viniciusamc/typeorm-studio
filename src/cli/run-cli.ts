import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  runStudioEngine,
  type StudioEngineExit,
} from '../drizzle/run-studio-engine.ts';
import {
  checkTargetReachable,
  type ReachabilityVerdict,
  type UnreachableReason,
} from '../typeorm/check-target-reachable.ts';
import {
  composeApplicationEnvironment,
  locateProject,
  ProjectLocationError,
  type ProjectLocation,
  type ProjectLocationFailure,
} from '../typeorm/locate-project.ts';
import {
  readConnectionTarget,
  type ReaderFailure,
} from '../typeorm/read-connection-target.ts';
import {
  describeTarget,
  makeTargetReadOnly,
  type ConnectionTarget,
} from '../typeorm/resolve-connection-target.ts';

export type CliEnvironment = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly shellEnv: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion: string;
  readonly stdout: { write(text: string): unknown; readonly isTTY?: boolean };
  readonly openBrowser: (url: string) => void;
  readonly stderr: { write(text: string): unknown };
  readonly stopSignal: AbortSignal;
};

type CliOptions = {
  readonly startDir: string;
  readonly datasourceFile: string | undefined;
  readonly envFiles: readonly string[];
  readonly port: number | undefined;
  readonly write: boolean;
  readonly dryRun: boolean;
  readonly open: boolean;
  readonly verbose: boolean;
};

type FailureText = { readonly message: string; readonly hint: string };

class CliFailure extends Error {
  readonly exitCode: number;
  readonly hint: string;

  constructor(exitCode: number, text: FailureText) {
    super(text.message);
    this.exitCode = exitCode;
    this.hint = text.hint;
  }
}

const exitCodes = {
  ok: 0,
  crashed: 1,
  usage: 2,
  project: 3,
  load: 4,
  unsupported: 5,
  unreachable: 6,
  studio: 7,
} as const;

const reachabilityTimeoutMs = 5_000;
const readerTimeoutMs = 30_000;

const helpText = `Usage: typeorm-studio [project-dir] [options]

Opens Drizzle Studio on the database of a TypeORM project (unofficial).

Options:
  -d, --datasource <file>  DataSource file to use instead of discovery
      --env-file <file>    env file to load; repeatable, later wins; turns off .env discovery
  -p, --port <number>      Studio port (default 4983)
      --write              allow edits (Studio starts read-only)
      --dry-run            find the project, load it and check the database, then stop
      --no-open            print the Studio link without opening the browser
      --verbose            print timings and warnings
  -h, --help               show this help
  -v, --version            show the version
`;

export async function runCli(environment: CliEnvironment): Promise<number> {
  try {
    assertSupportedNodeVersion(environment.nodeVersion);
    const command = parseCliCommand(environment);
    if (command === 'help') {
      environment.stdout.write(helpText);
      return exitCodes.ok;
    }
    if (command === 'version') {
      environment.stdout.write(`${readPackageVersion()}\n`);
      return exitCodes.ok;
    }
    return await openStudio(command, environment);
  } catch (error) {
    if (error instanceof ProjectLocationError) {
      writeFailure(
        environment,
        describeLocationFailure(error.failure, environment.cwd),
      );
      return exitCodes.project;
    }
    if (!(error instanceof CliFailure)) throw error;
    writeFailure(environment, error);
    return error.exitCode;
  }
}

function assertSupportedNodeVersion(nodeVersion: string): void {
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 15)) return;
  throw new CliFailure(exitCodes.usage, {
    message: `typeorm-studio needs Node >= 22.15, found ${nodeVersion}`,
    hint: 'Install a newer Node (22.15+, 24 or 26) and run it again',
  });
}

function parseCliCommand(
  environment: CliEnvironment,
): CliOptions | 'help' | 'version' {
  const { values, positionals } = parseCliArguments(environment.argv);
  if (values.help) return 'help';
  if (values.version) return 'version';
  if (positionals.length > 1) {
    throw new CliFailure(exitCodes.usage, {
      message: `Expected at most one project directory, got ${positionals.length}: ${positionals.join(' ')}`,
      hint: 'Run typeorm-studio --help',
    });
  }
  return {
    startDir: path.resolve(environment.cwd, positionals[0] ?? '.'),
    datasourceFile:
      values.datasource === undefined
        ? undefined
        : path.resolve(environment.cwd, values.datasource),
    envFiles: (values['env-file'] ?? []).map((file) =>
      path.resolve(environment.cwd, file),
    ),
    port: parsePortOption(values.port),
    write: values.write,
    dryRun: values['dry-run'],
    open: !values['no-open'],
    verbose: values.verbose,
  };
}

function parseCliArguments(argv: readonly string[]): {
  readonly values: {
    readonly datasource?: string;
    readonly 'env-file'?: string[];
    readonly port?: string;
    readonly write: boolean;
    readonly 'dry-run': boolean;
    readonly 'no-open': boolean;
    readonly verbose: boolean;
    readonly help: boolean;
    readonly version: boolean;
  };
  readonly positionals: readonly string[];
} {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        datasource: { type: 'string', short: 'd' },
        'env-file': { type: 'string', multiple: true },
        port: { type: 'string', short: 'p' },
        write: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'no-open': { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    throw new CliFailure(exitCodes.usage, {
      message: error instanceof Error ? error.message : String(error),
      hint: 'Run typeorm-studio --help',
    });
  }
}

function parsePortOption(rawPort: string | undefined): number | undefined {
  if (rawPort === undefined) return undefined;
  const port = Number(rawPort);
  if (Number.isInteger(port) && port >= 1 && port <= 65_535) return port;
  throw new CliFailure(exitCodes.usage, {
    message: `--port must be an integer from 1 to 65535, got "${rawPort}"`,
    hint: 'Omit --port to use 4983 or the next free port',
  });
}

async function openStudio(
  options: CliOptions,
  environment: CliEnvironment,
): Promise<number> {
  const startedAt = performance.now();
  const location = locateProject({
    startDir: options.startDir,
    explicitDatasourceFile: options.datasourceFile,
    explicitEnvFiles: options.envFiles,
  });
  const datasourceFile = displayPath(environment.cwd, location.datasourceFile);
  writeStep(environment, 'datasource', datasourceFile);
  writeStep(environment, '', location.foundBy);
  writeStep(environment, 'env', describeEnvFiles(location, environment.cwd));
  writeTiming(environment, options, 'located in', startedAt);

  const loadedAt = performance.now();
  const outcome = await readConnectionTarget({
    location,
    applicationEnvironment: composeApplicationEnvironment({
      envFiles: location.envFiles,
      shellEnv: environment.shellEnv,
    }),
    timeoutMs: readerTimeoutMs,
  });
  writeTiming(environment, options, 'loaded in', loadedAt);
  if (outcome.kind === 'unsupported') {
    throw new CliFailure(exitCodes.unsupported, {
      message: `TypeORM type "${outcome.typeormType}" is not supported yet`,
      hint: 'Supported for now: postgres',
    });
  }
  if (outcome.kind === 'failed') {
    writeReaderOutput(environment, options, outcome.failure);
    throw new CliFailure(
      exitCodes.load,
      describeReaderFailure(outcome.failure, datasourceFile),
    );
  }
  for (const warning of outcome.warnings)
    environment.stderr.write(`  warn        ${warning}\n`);

  const target = options.write
    ? outcome.target
    : makeTargetReadOnly(outcome.target);
  writeStep(
    environment,
    'database',
    `${describeTarget(target)} (credentials hidden)`,
  );
  writeStep(
    environment,
    'mode',
    options.write ? 'read-write' : 'read-only (pass --write to edit)',
  );

  const verdict = await checkTargetReachable(target, {
    timeoutMs: reachabilityTimeoutMs,
  });
  if (!verdict.reachable) {
    throw new CliFailure(
      exitCodes.unreachable,
      describeUnreachableTarget(target, verdict),
    );
  }
  writeStep(
    environment,
    'check',
    `reachable in ${Math.round(verdict.elapsedMs)} ms`,
  );

  if (options.dryRun) {
    writeStep(environment, 'dry run', 'done, Studio not started');
    return exitCodes.ok;
  }
  return await serveStudio(target, options, environment);
}

async function serveStudio(
  target: ConnectionTarget,
  options: CliOptions,
  environment: CliEnvironment,
): Promise<number> {
  const exit = await runStudioEngine({
    database: target,
    port: options.port,
    abortSignal: environment.stopSignal,
    onListening: (studio) => {
      // OSC 8 makes the URL clickable; terminals without support show the text.
      const link = environment.stdout.isTTY
        ? `\u001B]8;;${studio.url}\u001B\\${studio.url}\u001B]8;;\u001B\\`
        : studio.url;
      writeStep(environment, 'studio', link);
      if (options.open) environment.openBrowser(studio.url);
      writeStep(
        environment,
        '',
        `${options.open ? 'opening it in your browser' : 'open it in your browser'}; press Ctrl-C to stop`,
      );
    },
  });
  if (exit.kind === 'stopped') return exitCodes.ok;
  if ('outputTail' in exit && exit.outputTail.trim() !== '') {
    environment.stderr.write(`  output      ${exit.outputTail.trim()}\n`);
  }
  throw describeEngineExit(exit);
}

function describeEngineExit(
  exit: Exclude<StudioEngineExit, { kind: 'stopped' }>,
): CliFailure {
  switch (exit.kind) {
    case 'port-busy':
      return new CliFailure(exitCodes.studio, {
        message: `Port ${exit.port} on 127.0.0.1 is already in use`,
        hint: 'Pick another one with --port <number>, or omit --port to get a free one',
      });
    case 'pins-mismatch':
      return new CliFailure(exitCodes.studio, {
        message: `${exit.packageName} ${exit.found} is installed, but typeorm-studio needs ${exit.expected}`,
        hint: 'Reinstall typeorm-studio; its drizzle-kit and drizzle-orm versions are pinned together',
      });
    case 'gate-refused':
      return new CliFailure(exitCodes.studio, {
        message:
          'The Studio engine could not be locked to https://local.drizzle.studio, so it was not started',
        hint: 'drizzle-kit may have changed how it starts its server; check the pinned version',
      });
    case 'engine-failed':
      return new CliFailure(
        exit.phase === 'running' ? exitCodes.crashed : exitCodes.studio,
        {
          message: `The Studio engine ${exit.phase === 'running' ? 'stopped unexpectedly' : 'stopped before it was ready'} (exit code ${exit.exitCode ?? 'none'}, signal ${exit.signal ?? 'none'})`,
          hint: 'The output above is the end of what the engine printed',
        },
      );
  }
}

function describeLocationFailure(
  failure: ProjectLocationFailure,
  cwd: string,
): FailureText {
  switch (failure.reason) {
    case 'datasource-not-found':
      return {
        message: `No TypeORM DataSource file found under ${failure.searchedDirs.map((dir) => displayPath(cwd, dir)).join(', ')}`,
        hint: 'Point at it with -d <file>, e.g. -d src/data-source.ts',
      };
    case 'datasource-ambiguous':
      return {
        message: `Several DataSource files found:\n${failure.candidates.map((file) => `                - ${displayPath(cwd, file)}`).join('\n')}`,
        hint: 'Pick one with -d <file>',
      };
    case 'datasource-file-missing':
      return {
        message: `DataSource file not found: ${displayPath(cwd, failure.file)}`,
        hint: 'Check the -d path; it is relative to the current folder',
      };
    case 'env-file-missing':
      return {
        message: `Env file not found or unreadable: ${displayPath(cwd, failure.file)}`,
        hint: 'Check the --env-file path; it is relative to the current folder',
      };
    case 'package-json-missing':
      return {
        message: `No package.json above ${displayPath(cwd, failure.file)}`,
        hint: 'Run typeorm-studio inside a Node project',
      };
  }
}

function describeReaderFailure<Reason extends ReaderFailure['reason']>(
  failure: Extract<ReaderFailure, { reason: Reason }>,
  datasourceFile: string,
): FailureText {
  const envHint =
    'Set the variables in .env, pass --env-file <file>, or export them in your shell';
  const texts: {
    readonly [Key in ReaderFailure['reason']]: (
      failure: Extract<ReaderFailure, { reason: Key }>,
    ) => FailureText;
  } = {
    'no-datasource-export': ({ exportNames }) => ({
      message: `${datasourceFile} exports no DataSource (exports: ${exportNames.length === 0 ? 'none' : exportNames.join(', ')})`,
      hint: 'Export a DataSource, a DataSourceOptions object with a type such as "postgres", or a default zero-argument function returning one',
    }),
    'several-datasources': ({ exportNames }) => ({
      message: `${datasourceFile} exports several DataSources: ${exportNames.join(', ')}`,
      hint: 'Point -d at a file that exports only one',
    }),
    'process-exit': ({ exitCode }) => ({
      message: `${datasourceFile} called process.exit(${exitCode}) while loading`,
      hint: `Usually a missing env variable. ${envHint}`,
    }),
    'invalid-environment': ({ keyNames }) => ({
      message: `The project's env validation failed for: ${keyNames.join(', ')}`,
      hint: envHint,
    }),
    'environment-not-loaded': ({ optionKey }) => ({
      message: `TypeORM option "${optionKey}" is undefined or NaN: the environment was not loaded`,
      hint: envHint,
    }),
    'module-not-found': ({ specifier }) => ({
      message: `Cannot resolve "${specifier}" while loading ${datasourceFile}`,
      hint: "Install the project's dependencies, or check tsconfig paths",
    }),
    'import-error': ({ errorName, errorCode, message }) => ({
      message: `${errorName}${errorCode === undefined ? '' : ` [${errorCode}]`} while loading ${datasourceFile}: ${message}`,
      hint: 'Run with --verbose to see the output of the loader',
    }),
    'reader-crashed': ({ exitCode }) => ({
      message: `The DataSource loader exited unexpectedly (exit code ${exitCode ?? 'none'})`,
      hint: 'Run with --verbose to see its output',
    }),
    'reader-timed-out': () => ({
      message: `Loading ${datasourceFile} took longer than ${readerTimeoutMs / 1000} s`,
      hint: 'Something in the import graph waits forever (a connection or a timer at import?); run with --verbose',
    }),
  };
  return texts[failure.reason](failure);
}

function describeUnreachableTarget(
  target: ConnectionTarget,
  verdict: Extract<ReachabilityVerdict, { reachable: false }>,
): FailureText {
  const texts: Record<UnreachableReason, FailureText> = {
    'connection-refused': {
      message: 'connection refused',
      hint: 'Is the database running? Check host and port',
    },
    'host-not-found': {
      message: 'host not found',
      hint: 'Check the host name',
    },
    timeout: {
      message: `no answer within ${reachabilityTimeoutMs / 1000} s`,
      hint: 'Check host, port, firewall or VPN',
    },
    'authentication-failed': {
      message: 'authentication failed',
      hint: 'Check the user and password your env provides',
    },
    'database-not-found': {
      message: 'database does not exist',
      hint: 'Create it, or check the database name',
    },
    'tls-not-supported-by-server': {
      message: 'the server does not support TLS',
      hint: 'Set ssl: false in the TypeORM options, or drop sslmode from the URL',
    },
    'tls-required-by-server': {
      message: 'the server requires TLS',
      hint: 'Enable ssl in the TypeORM options',
    },
    'tls-verification-failed': {
      message: 'the TLS certificate could not be verified',
      hint: 'Check ssl.ca, or rejectUnauthorized for a self-signed certificate',
    },
    'startup-options-rejected': {
      message: 'the server or pooler rejected the startup options',
      hint: 'Read-only mode sends startup options; connect without the pooler, or use --write',
    },
    unknown: { message: 'unexpected driver error', hint: 'Run with --verbose' },
  };
  const text = texts[verdict.reason];
  const driverCode =
    verdict.driverCode === undefined ? '' : ` (${verdict.driverCode})`;
  return {
    message: `Cannot reach ${describeTarget(target)}: ${text.message}${driverCode}`,
    hint: text.hint,
  };
}

function describeEnvFiles(location: ProjectLocation, cwd: string): string {
  if (location.envFiles.length === 0)
    return 'no .env files found, shell environment only';
  return location.envFiles
    .map((file) => `${displayPath(cwd, file.path)} (${file.keyCount} keys)`)
    .join(', ');
}

function displayPath(cwd: string, file: string): string {
  const relative = path.relative(cwd, file);
  if (relative === '') return '.';
  return relative.startsWith(`..${path.sep}..`) ? file : relative;
}

function writeStep(
  environment: CliEnvironment,
  label: string,
  text: string,
): void {
  environment.stdout.write(`  ${label.padEnd(10)}  ${text}\n`);
}

function writeFailure(environment: CliEnvironment, failure: FailureText): void {
  environment.stderr.write(
    `  error       ${failure.message}\n  hint        ${failure.hint}\n`,
  );
}

function writeTiming(
  environment: CliEnvironment,
  options: CliOptions,
  label: string,
  startedAt: number,
): void {
  if (!options.verbose) return;
  writeStep(
    environment,
    '',
    `${label} ${Math.round(performance.now() - startedAt)} ms`,
  );
}

function writeReaderOutput(
  environment: CliEnvironment,
  options: CliOptions,
  failure: ReaderFailure,
): void {
  if (!options.verbose) return;
  if (
    failure.reason !== 'reader-crashed' &&
    failure.reason !== 'reader-timed-out'
  )
    return;
  environment.stderr.write(
    `  output      ${failure.outputTail.trim() || '(empty)'}\n`,
  );
}

function readPackageVersion(): string {
  const packageJson: unknown = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const version =
    typeof packageJson === 'object' &&
    packageJson !== null &&
    'version' in packageJson
      ? packageJson.version
      : undefined;
  return typeof version === 'string' ? version : 'unknown';
}
