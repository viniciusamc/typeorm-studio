import { Client } from 'pg';
import type { QueryConfig } from 'pg';
import { toPgClientConfig } from './resolve-connection-target.ts';
import type { ConnectionTarget } from './resolve-connection-target.ts';

export type UnreachableReason =
  | 'connection-refused'
  | 'host-not-found'
  | 'timeout'
  | 'authentication-failed'
  | 'database-not-found'
  | 'tls-not-supported-by-server'
  | 'tls-required-by-server'
  | 'tls-verification-failed'
  | 'startup-options-rejected'
  | 'unknown';

export type ReachabilityVerdict =
  | {
      readonly reachable: true;
      readonly elapsedMs: number;
      readonly readOnly: boolean;
    }
  | {
      readonly reachable: false;
      readonly reason: UnreachableReason;
      readonly driverCode: string | undefined;
    };

export async function checkTargetReachable(
  target: ConnectionTarget,
  limits: { readonly timeoutMs: number },
): Promise<ReachabilityVerdict> {
  if (!Number.isFinite(limits.timeoutMs) || limits.timeoutMs <= 0) {
    throw new RangeError(
      `limits.timeoutMs must be a positive number of milliseconds, got ${limits.timeoutMs}`,
    );
  }

  const startedAt = performance.now();
  const deadline = startedAt + limits.timeoutMs;
  let client: Client | undefined;
  try {
    client = new Client({
      ...toPgClientConfig(target),
      connectionTimeoutMillis: limits.timeoutMs,
    });
    // pg emits 'error' for failures after connect; without a listener that
    // would crash the process instead of reaching the verdict.
    client.on('error', () => undefined);
    await client.connect();
    await client.query(queryWithinBudget('SELECT 1', deadline));
    const setting = await client.query<{
      default_transaction_read_only: string;
    }>(queryWithinBudget('SHOW default_transaction_read_only', deadline));
    return {
      reachable: true,
      elapsedMs: Math.round(performance.now() - startedAt),
      readOnly: setting.rows[0]?.default_transaction_read_only === 'on',
    };
  } catch (error) {
    return { reachable: false, ...classifyConnectionFailure(error, target) };
  } finally {
    if (client) await endClientWithin(client, Math.min(limits.timeoutMs, 1000));
  }
}

// query_timeout is honoured per query by pg but missing from QueryConfig.
function queryWithinBudget(
  text: string,
  deadline: number,
): QueryConfig & { readonly query_timeout: number } {
  return {
    text,
    query_timeout: Math.max(1, Math.ceil(deadline - performance.now())),
  };
}

// A server that stops answering after the handshake would keep a graceful
// end() waiting forever.
async function endClientWithin(
  client: Client,
  maxWaitMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const giveUp = setTimeout(resolve, maxWaitMs);
    giveUp.unref();
    const finish = (): void => {
      clearTimeout(giveUp);
      resolve();
    };
    client.end().then(finish, finish);
  });
}

// The verdict carries the reason and the driver code only: driver messages can
// quote the user, the database or the host, and credentials must never travel.
function classifyConnectionFailure(
  error: unknown,
  target: ConnectionTarget,
): {
  readonly reason: UnreachableReason;
  readonly driverCode: string | undefined;
} {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : undefined;
  const message = error instanceof Error ? error.message : '';
  return {
    reason: pickUnreachableReason(
      code,
      message,
      target.startupOptions !== undefined,
    ),
    driverCode: code,
  };
}

function pickUnreachableReason(
  code: string | undefined,
  message: string,
  sentStartupOptions: boolean,
): UnreachableReason {
  if (code !== undefined) {
    const reason = pickReasonFromCode(code, message, sentStartupOptions);
    if (reason !== undefined) return reason;
  }

  const reasonsByMessage: ReadonlyArray<readonly [RegExp, UnreachableReason]> =
    [
      [/timeout expired|Query read timeout|connection timeout/i, 'timeout'],
      [/does not support SSL connections/i, 'tls-not-supported-by-server'],
      [/^SASL:/, 'authentication-failed'],
    ];
  return (
    reasonsByMessage.find(([pattern]) => pattern.test(message))?.[1] ??
    'unknown'
  );
}

function pickReasonFromCode(
  code: string,
  message: string,
  sentStartupOptions: boolean,
): UnreachableReason | undefined {
  const reasonsByCode = new Map<string, UnreachableReason>([
    ['ECONNREFUSED', 'connection-refused'],
    ['ENOENT', 'connection-refused'],
    ['ENOTFOUND', 'host-not-found'],
    ['EAI_AGAIN', 'host-not-found'],
    ['ETIMEDOUT', 'timeout'],
    ['28P01', 'authentication-failed'],
    ['42501', 'authentication-failed'],
    ['3D000', 'database-not-found'],
    ...[
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'CERT_REVOKED',
      'CERT_UNTRUSTED',
    ].map((tlsCode): [string, UnreachableReason] => [
      tlsCode,
      'tls-verification-failed',
    ]),
  ]);
  const reason = reasonsByCode.get(code);
  if (reason !== undefined) return reason;

  // Postgres words a pg_hba.conf rejection of an unencrypted connection with
  // the same SQLSTATE as any other rejection; only the message tells them apart.
  if (code === '28000') {
    return /no encryption|SSL off/i.test(message)
      ? 'tls-required-by-server'
      : 'authentication-failed';
  }
  if (sentStartupOptions && ['08P01', '42704', '22023'].includes(code)) {
    return 'startup-options-rejected';
  }
  return undefined;
}
