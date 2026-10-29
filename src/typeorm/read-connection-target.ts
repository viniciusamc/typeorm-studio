import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChildForOneMessage } from '../child-process/supervise-child.ts';
import type { OneMessageOutcome } from '../child-process/supervise-child.ts';
import type { ProjectLocation } from './locate-project.ts';
import type { ConnectionTarget } from './resolve-connection-target.ts';

export type ReaderFailure =
  | {
      readonly reason: 'no-datasource-export';
      readonly exportNames: readonly string[];
    }
  | {
      readonly reason: 'several-datasources';
      readonly exportNames: readonly string[];
    }
  | { readonly reason: 'process-exit'; readonly exitCode: number }
  | {
      readonly reason: 'invalid-environment';
      readonly keyNames: readonly string[];
    }
  | { readonly reason: 'environment-not-loaded'; readonly optionKey: string }
  | { readonly reason: 'module-not-found'; readonly specifier: string }
  | {
      readonly reason: 'import-error';
      readonly errorName: string;
      readonly errorCode: string | undefined;
      readonly message: string;
    }
  | {
      readonly reason: 'reader-crashed';
      readonly exitCode: number | null;
      readonly outputTail: string;
    }
  | { readonly reason: 'reader-timed-out'; readonly outputTail: string };

export type ReadOutcome =
  | {
      readonly kind: 'target';
      readonly target: ConnectionTarget;
      readonly warnings: readonly string[];
    }
  | { readonly kind: 'unsupported'; readonly typeormType: string }
  | { readonly kind: 'failed'; readonly failure: ReaderFailure };

// reader-process.ts imports readerChannel, ReaderMessage, ReaderChildFailure and
// maskSecrets from here, so both ends of the IPC agree on the channel, the shapes
// and the masking.
export const readerChannel = 'typeorm-studio/reader';

// JSON drops undefined values, so these keys may be missing on arrival.
type ReaderTargetOnWire = Omit<
  ConnectionTarget,
  'password' | 'applicationName' | 'startupOptions'
> &
  Partial<
    Pick<ConnectionTarget, 'password' | 'applicationName' | 'startupOptions'>
  >;

export type ReaderChildFailure =
  | Exclude<
      ReaderFailure,
      {
        readonly reason: 'import-error' | 'reader-crashed' | 'reader-timed-out';
      }
    >
  | {
      readonly reason: 'import-error';
      readonly errorName: string;
      readonly errorCode?: string;
      readonly message: string;
    };

export type ReaderMessage =
  | {
      readonly channel: typeof readerChannel;
      readonly kind: 'target';
      readonly target: ReaderTargetOnWire;
      readonly warnings: readonly string[];
    }
  | {
      readonly channel: typeof readerChannel;
      readonly kind: 'unsupported';
      readonly typeormType: string;
    }
  | {
      readonly channel: typeof readerChannel;
      readonly kind: 'failed';
      readonly failure: ReaderChildFailure;
    };

export async function readConnectionTarget(request: {
  readonly location: ProjectLocation;
  readonly applicationEnvironment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): Promise<ReadOutcome> {
  // NODE_OPTIONS could preload a loader or inspector of the user's own and break
  // the reader, which depends on its own hooks.
  const { NODE_OPTIONS: _nodeOptions, ...inheritedEnvironment } =
    request.applicationEnvironment;
  const currentFile = fileURLToPath(import.meta.url);
  const outcome = await runChildForOneMessage<ReaderMessage>(
    {
      label: 'DataSource reader',
      entry: path.join(
        path.dirname(currentFile),
        `reader-process${path.extname(currentFile)}`,
      ),
      entryArguments: [request.location.datasourceFile],
      nodeArguments: ['--enable-source-maps'],
      cwd: request.location.packageDir,
      environment: {
        ...inheritedEnvironment,
        DOTENV_CONFIG_QUIET: 'true',
        TYPEORM_STUDIO: '1',
      },
    },
    { timeoutMs: request.timeoutMs, isExpectedMessage: isReaderMessage },
  );
  return describeReadOutcome(outcome, request.applicationEnvironment);
}

// Child output and error messages are kept only after this pass: it hides the
// values of secret-looking variables and the credentials inside URLs.
export function maskSecrets(
  text: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const secretValues: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value.length < 4) continue;
    if (/PASS|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE/i.test(name)) {
      secretValues.push(value);
    }
  }
  // Longest first, so a secret that contains another one is masked as a whole.
  secretValues.sort((first, second) => second.length - first.length);
  let masked = text;
  for (const secretValue of secretValues) {
    masked = masked.replaceAll(secretValue, '***');
  }
  return masked.replace(
    /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]*:[^\s/@]*@/gi,
    '$1***@',
  );
}

function describeReadOutcome(
  outcome: OneMessageOutcome<ReaderMessage>,
  environment: Readonly<Record<string, string>>,
): ReadOutcome {
  if (outcome.kind === 'timed-out') {
    return {
      kind: 'failed',
      failure: {
        reason: 'reader-timed-out',
        outputTail: maskSecrets(outcome.outputTail, environment),
      },
    };
  }
  if (outcome.kind === 'exited-without-message') {
    return {
      kind: 'failed',
      failure: {
        reason: 'reader-crashed',
        exitCode: outcome.exitCode,
        outputTail: maskSecrets(outcome.outputTail, environment),
      },
    };
  }
  const message = outcome.message;
  if (message.kind === 'unsupported') {
    return { kind: 'unsupported', typeormType: message.typeormType };
  }
  if (message.kind === 'failed') {
    return {
      kind: 'failed',
      failure:
        message.failure.reason === 'import-error'
          ? { ...message.failure, errorCode: message.failure.errorCode }
          : message.failure,
    };
  }
  return {
    kind: 'target',
    target: {
      ...message.target,
      password: message.target.password,
      applicationName: message.target.applicationName,
      startupOptions: message.target.startupOptions,
    },
    warnings: message.warnings,
  };
}

function isReaderMessage(value: unknown): value is ReaderMessage {
  if (!isWireRecord(value) || value.channel !== readerChannel) return false;
  if (value.kind === 'target') {
    return isReaderTarget(value.target) && isWireStringArray(value.warnings);
  }
  if (value.kind === 'unsupported')
    return typeof value.typeormType === 'string';
  return value.kind === 'failed' && isChildFailure(value.failure);
}

function isReaderTarget(value: unknown): value is ReaderTargetOnWire {
  return (
    isWireRecord(value) &&
    value.dialect === 'postgres' &&
    ['typeormType', 'host', 'user', 'database'].every(
      (name) => typeof value[name] === 'string',
    ) &&
    typeof value.port === 'number' &&
    areOptionalStringsAt(value, [
      'password',
      'applicationName',
      'startupOptions',
    ]) &&
    isReaderTls(value.tls)
  );
}

function isReaderTls(value: unknown): boolean {
  if (value === false) return true;
  return (
    isWireRecord(value) &&
    typeof value.rejectUnauthorized === 'boolean' &&
    areOptionalStringsAt(value, [
      'ca',
      'cert',
      'key',
      'passphrase',
      'servername',
    ])
  );
}

function isChildFailure(value: unknown): value is ReaderChildFailure {
  if (!isWireRecord(value) || typeof value.reason !== 'string') return false;
  const hasValidFields = new Map<
    string,
    (failure: Record<string, unknown>) => boolean
  >([
    [
      'no-datasource-export',
      (failure) => isWireStringArray(failure.exportNames),
    ],
    [
      'several-datasources',
      (failure) => isWireStringArray(failure.exportNames),
    ],
    ['process-exit', (failure) => typeof failure.exitCode === 'number'],
    ['invalid-environment', (failure) => isWireStringArray(failure.keyNames)],
    [
      'environment-not-loaded',
      (failure) => typeof failure.optionKey === 'string',
    ],
    ['module-not-found', (failure) => typeof failure.specifier === 'string'],
    [
      'import-error',
      (failure) =>
        typeof failure.errorName === 'string' &&
        typeof failure.message === 'string' &&
        areOptionalStringsAt(failure, ['errorCode']),
    ],
  ]).get(value.reason);
  return hasValidFields !== undefined && hasValidFields(value);
}

function areOptionalStringsAt(
  record: Readonly<Record<string, unknown>>,
  names: readonly string[],
): boolean {
  return names.every(
    (name) => record[name] === undefined || typeof record[name] === 'string',
  );
}

function isWireStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isWireRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
