/**
 * Runtime diagnostics tools (#1824): read-only views over a project's dev
 * database `_smrt_*` system tables, powered by the shared SELECT-only
 * system-diagnostics reader in `@happyvertical/smrt-core`.
 *
 * Contract:
 * - **Optional connection.** No configured connection returns a successful
 *   static-only envelope — the server always starts and static tools are
 *   unaffected. A live connection is opened lazily per call and closed in
 *   `finally`; nothing is cached across calls.
 * - **Read-only.** Every underlying statement is a bounded SELECT; the reader
 *   never selects sensitive columns (job payloads/results, schedule
 *   `agentConfig`/`methodArgs`, dispatch `payload`/`metadata`).
 * - **Provenance-labeled.** Live results carry `provenance: 'runtime (live DB)'`;
 *   static-only results carry `provenance: 'static'` — agents must never
 *   conflate runtime facts with declared/manifest facts.
 * - **Fail-safe.** A connect/read error becomes a diagnostic envelope; it must
 *   never reach the MCP transport and never includes raw driver text or URLs.
 */

import {
  readDispatchHealth,
  readJobHealth,
  readMigrationStatus,
  readRecentChanges,
  readRegistryDrift,
  readScheduleHealth,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  closeRuntimeConnection,
  type RuntimeDatabaseArgs,
  redactConnectionString,
  resolveRuntimeConnection,
  safeErrorMessage,
} from './connection.js';

/** Provenance labels separating runtime facts from static/declared facts. */
export const RUNTIME_PROVENANCE = 'runtime (live DB)';
export const STATIC_PROVENANCE = 'static';

export interface RuntimeDiagnostic {
  severity: 'info' | 'warning';
  code: string;
  message: string;
}

export interface RuntimeToolEnvelope {
  ok: true;
  coverage: null;
  diagnostics: RuntimeDiagnostic[];
  data: Record<string, unknown>;
}

type RuntimeReadParts = {
  data: Record<string, unknown>;
  diagnostics: RuntimeDiagnostic[];
};

type RuntimeRead = (db: DatabaseInterface) => Promise<RuntimeReadParts>;

/**
 * Serialize resolve → read → close per connection target so overlapping tool
 * calls never close a shared cached handle out from under each other.
 *
 * `@happyvertical/sql`'s `getDatabase` returns a cached handle per URL (no
 * opt-out in its public API), and `closeRuntimeConnection` evicts that cached
 * handle. Two concurrent diagnostics calls resolving the same URL would
 * otherwise share one handle, with the first finisher closing it mid-read for
 * the second. A per-key promise chain keeps each call's lifecycle private:
 * every call resolves its own view of the connection, performs its read, and
 * only then closes — the next queued call re-resolves a fresh handle.
 */
const runtimeReadQueues = new Map<string, Promise<unknown>>();

function connectionQueueKey(args: RuntimeDatabaseArgs): string {
  return (
    args.dbUrl?.trim() || process.env.SMRT_DEV_DB_URL?.trim() || 'cli.config'
  );
}

async function enqueueRuntimeRead<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = runtimeReadQueues.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  // Track a never-rejecting tail so later calls chain regardless of outcome,
  // then drop the entry once this is the settled tail to bound map size.
  const tail = run.catch(() => undefined);
  runtimeReadQueues.set(key, tail);
  void tail.then(() => {
    if (runtimeReadQueues.get(key) === tail) {
      runtimeReadQueues.delete(key);
    }
  });
  return run;
}

/**
 * Run one read against the optional runtime connection, mapping every outcome
 * to a successful MCP envelope:
 *
 * - no connection configured → static-only envelope (`connected: false`)
 * - connect failure → static envelope with a safe diagnostic
 * - read failure → connected envelope with a safe diagnostic
 * - success → live result under `provenance: 'runtime (live DB)'`; a
 *   category-unavailable reader result keeps its `available: false` data and
 *   surfaces its message as a diagnostic
 */
async function withRuntimeConnection(
  args: RuntimeDatabaseArgs,
  read: RuntimeRead,
  staticHint: string,
): Promise<RuntimeToolEnvelope> {
  // Serialize the full resolve → read → close lifecycle per connection target
  // (see `runtimeReadQueues`) so concurrent calls sharing one cached handle
  // cannot close it mid-read for each other.
  return enqueueRuntimeRead(connectionQueueKey(args), () =>
    runWithRuntimeConnection(args, read, staticHint),
  );
}

async function runWithRuntimeConnection(
  args: RuntimeDatabaseArgs,
  read: RuntimeRead,
  staticHint: string,
): Promise<RuntimeToolEnvelope> {
  let resolved: Awaited<ReturnType<typeof resolveRuntimeConnection>>;
  try {
    resolved = await resolveRuntimeConnection(args);
  } catch (error) {
    return {
      ok: true,
      coverage: null,
      diagnostics: [
        {
          severity: 'warning',
          code: 'runtime_connection_error',
          message: safeErrorMessage(error),
        },
      ],
      data: {
        provenance: STATIC_PROVENANCE,
        connected: false,
      },
    };
  }

  if (!resolved.db) {
    return {
      ok: true,
      coverage: null,
      diagnostics: [
        {
          severity: 'info',
          code: 'runtime_connection_unavailable',
          message: `No runtime dev database configured (set SMRT_DEV_DB_URL or cli.database); returning static-only result: ${staticHint}. Static tools are unaffected.`,
        },
      ],
      data: {
        provenance: STATIC_PROVENANCE,
        connected: false,
      },
    };
  }

  const { db, source, displayUrl, databaseType } = resolved;
  try {
    const { data, diagnostics } = await read(db);
    return {
      ok: true,
      coverage: null,
      diagnostics,
      data: {
        provenance: RUNTIME_PROVENANCE,
        connected: true,
        connectionSource: source,
        databaseType,
        displayUrl,
        ...data,
      },
    };
  } catch (error) {
    return {
      ok: true,
      coverage: null,
      diagnostics: [
        {
          severity: 'warning',
          code: 'runtime_read_error',
          message: safeErrorMessage(error),
        },
      ],
      data: {
        provenance: RUNTIME_PROVENANCE,
        connected: true,
        connectionSource: source,
        databaseType,
        displayUrl,
      },
    };
  } finally {
    await closeRuntimeConnection(db);
  }
}

/**
 * Stored error columns (`error_message`, `last_error`) are free text written
 * at failure time and routinely quote connection URLs or credentials. Every
 * string in a live result passes through {@link redactConnectionString}
 * before it reaches an MCP client; structure and non-string values are kept.
 */
function redactStrings<T>(value: T): T {
  if (typeof value === 'string') {
    return redactConnectionString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStrings(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = redactStrings(item);
    }
    return out as T;
  }
  return value;
}

/** Convert a reader result into envelope data + diagnostics. */
function toEnvelopeParts(rawResult: unknown): {
  data: Record<string, unknown>;
  diagnostics: RuntimeDiagnostic[];
} {
  const result = redactStrings(rawResult);
  if (
    result !== null &&
    typeof result === 'object' &&
    'available' in result &&
    (result as { available: unknown }).available === false
  ) {
    const unavailable = result as unknown as {
      reason: string;
      message: string;
      tableName?: string;
      [key: string]: unknown;
    };
    const { message, ...rest } = unavailable;
    const severity: RuntimeDiagnostic['severity'] =
      unavailable.reason === 'retired' ? 'info' : 'warning';
    return {
      data: rest,
      diagnostics: [
        {
          severity,
          code: `category_unavailable_${String(unavailable.reason).replace(/-/g, '_')}`,
          message: String(message),
        },
      ],
    };
  }
  return { data: result as Record<string, unknown>, diagnostics: [] };
}

function readToParts(read: Promise<unknown>): Promise<RuntimeReadParts> {
  return read.then((result) => toEnvelopeParts(result));
}

export interface MigrationStatusArgs extends RuntimeDatabaseArgs {
  /** Row budget for latest/failed lists (default 50, capped at 500). */
  limit?: number;
}

export async function runtimeMigrationStatus(
  args: MigrationStatusArgs = {},
): Promise<RuntimeToolEnvelope> {
  const { limit, ...connectionArgs } = args;
  return withRuntimeConnection(
    connectionArgs,
    (db) => readToParts(readMigrationStatus(db, { limit })),
    'no migration status — the manifest still reports the declared schema',
  );
}

export interface JobHealthArgs extends RuntimeDatabaseArgs {
  /** Row budget for the jobs list (default 50, capped at 500). */
  limit?: number;
}

export async function runtimeJobHealth(
  args: JobHealthArgs = {},
): Promise<RuntimeToolEnvelope> {
  const { limit, ...connectionArgs } = args;
  return withRuntimeConnection(
    connectionArgs,
    (db) => readToParts(readJobHealth(db, { limit })),
    'no job health snapshot — the manifest still reports declared job queues',
  );
}

export interface ScheduleHealthArgs extends RuntimeDatabaseArgs {
  /** Row budget for the schedules list (default 50, capped at 500). */
  limit?: number;
}

export async function runtimeScheduleHealth(
  args: ScheduleHealthArgs = {},
): Promise<RuntimeToolEnvelope> {
  const { limit, ...connectionArgs } = args;
  return withRuntimeConnection(
    connectionArgs,
    (db) => readToParts(readScheduleHealth(db, { limit })),
    'no schedule health snapshot — the manifest still reports declared schedules',
  );
}

export interface DispatchHealthArgs extends RuntimeDatabaseArgs {
  /** Row budget for messages/subscriptions lists (default 50, capped at 500). */
  limit?: number;
}

export async function runtimeDispatchHealth(
  args: DispatchHealthArgs = {},
): Promise<RuntimeToolEnvelope> {
  const { limit, ...connectionArgs } = args;
  return withRuntimeConnection(
    connectionArgs,
    (db) => readToParts(readDispatchHealth(db, { limit })),
    'no dispatch health snapshot — the manifest still reports declared dispatch topology',
  );
}

export interface RecentChangesArgs extends RuntimeDatabaseArgs {
  /** Cursor to read after (default 0). */
  since?: number;
  /** Restrict to these physical table names. */
  tables?: string[];
  /** Tenant narrowing filter. */
  tenantId?: string;
  /** Page size (default 200, capped at 500). */
  limit?: number;
}

export async function runtimeRecentChanges(
  args: RecentChangesArgs = {},
): Promise<RuntimeToolEnvelope> {
  const { since, tables, tenantId, limit, ...connectionArgs } = args;
  return withRuntimeConnection(
    connectionArgs,
    (db) =>
      readToParts(readRecentChanges(db, { since, tables, tenantId, limit })),
    'no recent changes — static knowledge artifacts are unchanged',
  );
}

export async function runtimeRegistryDrift(
  args: RuntimeDatabaseArgs = {},
): Promise<RuntimeToolEnvelope> {
  return withRuntimeConnection(
    args,
    (db) => readToParts(readRegistryDrift(db)),
    'no registry drift report — _smrt_registry is retired; declared objects come from the manifest',
  );
}
