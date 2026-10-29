import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { maskSecrets, readerChannel } from './read-connection-target.ts';
import type {
  ReaderChildFailure,
  ReaderMessage,
} from './read-connection-target.ts';
import {
  EnvironmentNotLoadedError,
  resolveConnectionTarget,
} from './resolve-connection-target.ts';
import {
  detectModuleSystem,
  installTypescriptHooks,
} from './typescript-hooks.ts';

type OptionsRecord = Readonly<Record<string, unknown>>;

type ClassifiedValue = {
  readonly kind: 'datasource' | 'options';
  readonly options: OptionsRecord;
};

type FoundOptions = {
  readonly exportName: string;
  readonly options: OptionsRecord;
};

type ExportScan = {
  readonly exportNames: readonly string[];
  readonly dataSources: readonly FoundOptions[];
  readonly optionObjects: readonly FoundOptions[];
  readonly defaultExport: unknown;
};

type OptionsSearch =
  | { readonly kind: 'found'; readonly options: OptionsRecord }
  | { readonly kind: 'failed'; readonly failure: ReaderChildFailure };

type ExitTrap = {
  readonly describeRequestedExit: () => ReaderChildFailure | undefined;
  readonly restore: () => void;
};

// The user's code may replace or trap process.exit while it loads, so the real one
// is kept for the lifeline and for the final exit.
const exitReaderProcess: (exitCode: number) => never =
  process.exit.bind(process);

process.on('disconnect', () => exitReaderProcess(1));
// A disconnect listener keeps the process alive for as long as the channel is open,
// which would hide the moment nothing is left to wait for.
process.channel?.unref();

const datasourceFile = process.argv[2];
if (
  datasourceFile === undefined ||
  process.send === undefined ||
  !process.connected
) {
  process.stderr.write(
    'reader-process expects the DataSource file as its only argument and an open IPC channel to its parent; start it through readConnectionTarget\n',
  );
  exitReaderProcess(2);
}

let isMessageSent = false;

installTypescriptHooks({ packageDir: process.cwd() });
const exitTrap = trapProcessExit();
// Without these two, a promise that can no longer settle or an error that nobody
// catches would end the process with a bare exit code instead of an answer.
process.once('beforeExit', () =>
  sendMessageThenExit(
    buildFailedMessage({
      reason: 'import-error',
      errorName: 'UnsettledLoad',
      message:
        'nothing is left that could finish loading the DataSource file; a top-level await or a promise it waits for never settles',
    }),
  ),
);
process.once('uncaughtException', (error) =>
  sendMessageThenExit(
    buildFailedMessage(
      exitTrap.describeRequestedExit() ?? describeThrownError(error),
    ),
  ),
);
sendMessageThenExit(await buildReaderMessage(datasourceFile, exitTrap));

function sendMessageThenExit(message: ReaderMessage): void {
  if (isMessageSent) return;
  isMessageSent = true;
  process.send?.(message, undefined, undefined, (error: Error | null) =>
    exitReaderProcess(error === null ? 0 : 1),
  );
}

async function buildReaderMessage(
  file: string,
  trap: ExitTrap,
): Promise<ReaderMessage> {
  let message: ReaderMessage;
  try {
    message = await readTargetMessage(file);
  } catch (error) {
    message = buildFailedMessage(describeThrownError(error));
  } finally {
    trap.restore();
  }
  // A module that swallows the trap's error and carries on has still tried to quit.
  const requestedExit = trap.describeRequestedExit();
  return requestedExit === undefined
    ? message
    : buildFailedMessage(requestedExit);
}

async function readTargetMessage(file: string): Promise<ReaderMessage> {
  const search = await findDatasourceOptions(await importDatasourceFile(file));
  if (search.kind === 'failed') return buildFailedMessage(search.failure);
  const resolved = await resolveConnectionTarget(search.options);
  if (resolved.kind === 'unsupported') {
    return {
      channel: readerChannel,
      kind: 'unsupported',
      typeormType: resolved.typeormType,
    };
  }
  return {
    channel: readerChannel,
    kind: 'target',
    target: resolved.target,
    warnings: resolved.warnings,
  };
}

function buildFailedMessage(failure: ReaderChildFailure): ReaderMessage {
  return { channel: readerChannel, kind: 'failed', failure };
}

function trapProcessExit(): ExitTrap {
  const realExit = process.exit;
  let requestedExitCode: number | undefined;
  process.exit = (exitCode?: number | string | null): never => {
    const requested = Number(exitCode ?? process.exitCode ?? 0);
    requestedExitCode ??= Number.isInteger(requested) ? requested : 1;
    throw new Error(
      `process.exit(${requestedExitCode}) was called while loading the DataSource file`,
    );
  };
  return {
    describeRequestedExit: () =>
      requestedExitCode === undefined
        ? undefined
        : { reason: 'process-exit', exitCode: requestedExitCode },
    restore: () => {
      process.exit = realExit;
    },
  };
}

// Same choice as TypeORM's importOrRequireFile, so a file that works with
// `typeorm -d <file>` loads the same way here.
async function importDatasourceFile(file: string): Promise<unknown> {
  if (detectModuleSystem(file) === 'module') {
    return import(pathToFileURL(file).href);
  }
  return createRequire(import.meta.url)(file);
}

async function findDatasourceOptions(
  moduleValue: unknown,
): Promise<OptionsSearch> {
  const itself = classifyDatasourceCandidate(moduleValue);
  if (itself !== undefined) return { kind: 'found', options: itself.options };

  const rootScan = await scanModuleExports(moduleValue);
  const direct = pickOptionsFromScan(rootScan);
  if (direct !== undefined) return direct;

  const defaultExport = rootScan.defaultExport;
  // A CommonJS build imported from ESM wraps its exports one level deeper.
  if (
    isObjectOrFunction(defaultExport) &&
    typeof defaultExport !== 'function'
  ) {
    const wrappedDirect = pickOptionsFromScan(
      await scanModuleExports(defaultExport),
    );
    if (wrappedDirect !== undefined) return wrappedDirect;
  }
  if (isZeroArgumentFunction(defaultExport)) {
    const produced = classifyDatasourceCandidate(await defaultExport());
    if (produced !== undefined) {
      return { kind: 'found', options: produced.options };
    }
  }
  return {
    kind: 'failed',
    failure: {
      reason: 'no-datasource-export',
      exportNames: rootScan.exportNames,
    },
  };
}

// TypeORM's own loadDataSource awaits every export one after the other, in case one
// is a Promise<DataSource>; the same order keeps the same side effects.
async function scanModuleExports(moduleValue: unknown): Promise<ExportScan> {
  if (!isObjectOrFunction(moduleValue)) {
    return {
      exportNames: [],
      dataSources: [],
      optionObjects: [],
      defaultExport: undefined,
    };
  }
  const exportNames = Object.keys(moduleValue);
  const dataSources: FoundOptions[] = [];
  const optionObjects: FoundOptions[] = [];
  const seenValues = new Set<unknown>();
  let defaultExport: unknown;
  for (const exportName of exportNames) {
    // oxlint-disable-next-line no-await-in-loop
    const exported: unknown = await Reflect.get(moduleValue, exportName);
    if (exportName === 'default') defaultExport = exported;
    const classified = classifyDatasourceCandidate(exported);
    if (classified === undefined || seenValues.has(exported)) continue;
    seenValues.add(exported);
    const found = { exportName, options: classified.options };
    if (classified.kind === 'datasource') dataSources.push(found);
    else optionObjects.push(found);
  }
  return { exportNames, dataSources, optionObjects, defaultExport };
}

// DataSource instances outrank bare options objects: a file may export both its
// options and the DataSource built from them.
function pickOptionsFromScan(scan: ExportScan): OptionsSearch | undefined {
  const candidates =
    scan.dataSources.length > 0 ? scan.dataSources : scan.optionObjects;
  if (candidates.length === 0) return undefined;
  if (candidates.length > 1) {
    return {
      kind: 'failed',
      failure: {
        reason: 'several-datasources',
        exportNames: candidates.map((candidate) => candidate.exportName),
      },
    };
  }
  return { kind: 'found', options: candidates[0].options };
}

// A DataSource is recognised by the marker TypeORM puts on every instance, never by
// instanceof: the project's typeorm is not the copy this process could import.
function classifyDatasourceCandidate(
  value: unknown,
): ClassifiedValue | undefined {
  if (!isObjectRecord(value)) return undefined;
  if (value['@instanceof'] === Symbol.for('DataSource')) {
    return isObjectRecord(value.options)
      ? { kind: 'datasource', options: value.options }
      : undefined;
  }
  if (
    Object.getPrototypeOf(value) === Object.prototype &&
    typeof value.type === 'string'
  ) {
    return { kind: 'options', options: value };
  }
  return undefined;
}

function describeThrownError(error: unknown): ReaderChildFailure {
  if (error instanceof EnvironmentNotLoadedError) {
    return { reason: 'environment-not-loaded', optionKey: error.optionKey };
  }
  const keyNames = readZodIssueKeyNames(error);
  if (keyNames !== undefined) {
    return { reason: 'invalid-environment', keyNames };
  }

  const errorCode = readStringProperty(error, 'code');
  const firstLine = maskSecrets(readThrownMessage(error), process.env).split(
    '\n',
    1,
  )[0];
  if (
    errorCode === 'ERR_MODULE_NOT_FOUND' ||
    errorCode === 'MODULE_NOT_FOUND'
  ) {
    const missing = /^Cannot find (?:package|module) '([^']+)'/.exec(firstLine);
    return { reason: 'module-not-found', specifier: missing?.[1] ?? firstLine };
  }
  return {
    reason: 'import-error',
    errorName: readStringProperty(error, 'name') ?? typeof error,
    errorCode,
    message: firstLine.slice(0, 300),
  };
}

// Only the keys: the message of a ZodError can quote the rejected values.
function readZodIssueKeyNames(error: unknown): string[] | undefined {
  if (readStringProperty(error, 'name') !== 'ZodError') return undefined;
  const issues = isObjectRecord(error) ? error.issues : undefined;
  if (!Array.isArray(issues)) return undefined;
  const keyNames = issues.map((issue: unknown) => {
    const issuePath = isObjectRecord(issue) ? issue.path : undefined;
    if (!Array.isArray(issuePath) || issuePath.length === 0) return '(root)';
    return issuePath.map(String).join('.');
  });
  return [...new Set(keyNames)];
}

function readThrownMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  return readStringProperty(error, 'message') ?? `a thrown ${typeof error}`;
}

function readStringProperty(value: unknown, name: string): string | undefined {
  const property = isObjectRecord(value) ? value[name] : undefined;
  return typeof property === 'string' ? property : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isObjectOrFunction(value: unknown): value is object {
  return isObjectRecord(value) || typeof value === 'function';
}

function isZeroArgumentFunction(value: unknown): value is () => unknown {
  return (
    typeof value === 'function' &&
    value.length === 0 &&
    !/^class[\s{]/.test(Function.prototype.toString.call(value))
  );
}
