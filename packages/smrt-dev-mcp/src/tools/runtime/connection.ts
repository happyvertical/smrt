/**
 * Optional read-only dev-database connection resolution for runtime
 * diagnostics tools (#1824).
 *
 * Resolution order per call:
 *   1. explicit `dbUrl`/`dbType` tool arguments
 *   2. `SMRT_DEV_DB_URL` environment variable
 *   3. the project's cosmiconfig CLI section (`getPackageConfig('cli', ...)`
 *      from `@happyvertical/smrt-config`) → `database.{type,url}`
 *
 * No configured connection → `db: null` with `source: 'none'`; callers return
 * a successful static-only envelope. A connection is always opened lazily per
 * call and closed in the caller's `finally` — nothing is cached across calls
 * and the server never holds a database handle.
 *
 * Sensitive handling: connection strings are never logged or echoed. Every
 * surfaced URL passes through {@link redactConnectionString}; driver errors
 * are surfaced only through {@link safeErrorMessage}, which strips anything
 * that looks like a credential-bearing URL.
 */

import { getPackageConfig } from '@happyvertical/smrt-config';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';

/** Engine labels `@happyvertical/sql`'s `getDatabase` accepts. */
export type RuntimeDatabaseType = 'sqlite' | 'postgres' | 'duckdb';

const RUNTIME_DATABASE_TYPES: readonly RuntimeDatabaseType[] = [
  'sqlite',
  'postgres',
  'duckdb',
];

function isRuntimeDatabaseType(value: string): value is RuntimeDatabaseType {
  return (RUNTIME_DATABASE_TYPES as readonly string[]).includes(value);
}

/** Tool arguments every runtime-diagnostics tool accepts. */
export interface RuntimeDatabaseArgs {
  /** Optional database URL/connection string (overrides env and config). */
  dbUrl?: string;
  /**
   * Optional engine hint for `dbUrl` or the environment connection.
   * Must be `'sqlite'` | `'postgres'` | `'duckdb'` (case-insensitive); any
   * other non-empty hint surfaces a safe diagnostic error rather than
   * silently opening the wrong adapter. When absent, the engine is inferred
   * from the URL scheme.
   */
  dbType?: string;
}

export type ConnectionSource = 'argument' | 'environment' | 'config' | 'none';

export interface ResolvedRuntimeConnection {
  /** Open connection, or `null` when no connection is configured. */
  db: DatabaseInterface | null;
  source: ConnectionSource;
  /** Redacted connection string for display; '' when no connection. */
  displayUrl: string;
  /**
   * Normalized engine label for the resolved connection (`sqlite`,
   * `postgres`, or `duckdb`); `null` when no connection is configured.
   */
  databaseType: string | null;
}

/**
 * Sensitive query-parameter names. Matching normalizes the key (lowercase,
 * `_`/`-` stripped), so camelCase (`authToken`, `accessToken`) and hyphen
 * variants (`api-key`) are masked exactly like their snake_case forms.
 */
const SENSITIVE_QUERY_PARAMS = [
  'access_token',
  'apikey',
  'api_key',
  'auth',
  'auth_token',
  'connectionstring',
  'connection_string',
  'password',
  'token',
];

function normalizeQueryParamName(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

const SENSITIVE_QUERY_PARAM_NAMES = new Set(
  SENSITIVE_QUERY_PARAMS.map(normalizeQueryParamName),
);

const DEFAULT_CLI_DATABASE = {
  database: { type: 'sqlite', url: ':memory:' },
};

/**
 * Redact a connection string so it can be shown to an agent without leaking
 * credentials. Mirrors the CLI's `redactConnectionString` (which is CLI
 * private); patterned identically so dev-mcp never depends on the CLI.
 *
 * Query-parameter masking normalizes each key (lowercase, `_`/`-` stripped),
 * so camelCase forms such as Turso/libsql's `?authToken=` mask exactly like
 * their snake_case forms. A final regex pass also masks `key=value` pairs
 * embedded in free text (driver error messages often quote the URL); it treats
 * `?`, `&`, `,`, `(`, and whitespace as the preceding boundary.
 */
export function redactConnectionString(value: string): string {
  let redacted = value;

  try {
    const url = new URL(value);
    if (url.password) {
      url.password = '***';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAM_NAMES.has(normalizeQueryParamName(key))) {
        url.searchParams.set(key, '***');
      }
    }
    redacted = url.toString();
  } catch {
    redacted = value.replace(
      // The password run may itself contain unencoded `@` (invalid but real
      // in driver errors); each interior `@` is consumed only when another
      // `@` follows before whitespace, so the mask always reaches the final
      // userinfo terminator instead of stopping at the first `@`.
      /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)(?:[^@\s]|@(?=[^@\s]*@))+(@)/gi,
      '$1***$2',
    );
  }

  // Free-text pass: mask the value of any sensitive `key=value` pair the URL
  // parse above may have left intact (e.g. a URL quoted inside an error
  // message, where `?`/`&` boundaries do not delimit params for `new URL`).
  return redacted.replace(
    /([?&,(\s]([a-z][a-z0-9_-]{0,30})=)([^&,\s)]+)/gi,
    (match, prefix: string, key: string) =>
      SENSITIVE_QUERY_PARAM_NAMES.has(normalizeQueryParamName(key))
        ? `${prefix}***`
        : match,
  );
}

/**
 * Build a safe, redacted error message for a database failure. Connection
 * strings and raw driver error objects are never surfaced verbatim.
 */
export function safeErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? 'unknown error');
  return redactConnectionString(message);
}

/**
 * Normalize a type hint into an engine `getDatabase` accepts. Unknown values
 * throw a safe error (no URL is included) so the caller can surface a
 * diagnostic instead of silently opening the wrong adapter.
 */
export function toRuntimeDatabaseType(value: string): RuntimeDatabaseType {
  const normalized = value.trim().toLowerCase();
  if (isRuntimeDatabaseType(normalized)) {
    return normalized;
  }
  throw new Error(
    `Unsupported runtime database type "${normalized}"; expected sqlite, postgres, or duckdb`,
  );
}

/** Infer an engine hint from a URL scheme when no explicit type is given. */
export function inferDatabaseType(url: string, hint?: string): string {
  if (hint && hint.trim().length > 0) return hint;
  if (/^postgres(ql)?:/i.test(url)) return 'postgres';
  if (/^duckdb:/i.test(url)) return 'duckdb';
  return 'sqlite';
}

/**
 * Resolve the dev-database connection for one tool call.
 *
 * Returns `db: null` (never throws) when no connection is configured; callers
 * must treat that as "no runtime database" and return a static-only envelope.
 * A thrown connect error is propagated to the caller, which converts it into
 * a diagnostic envelope — it must never reach the MCP transport.
 */
export async function resolveRuntimeConnection(
  args: RuntimeDatabaseArgs = {},
): Promise<ResolvedRuntimeConnection> {
  const argUrl = args.dbUrl?.trim();
  if (argUrl && argUrl !== ':memory:') {
    const databaseType = toRuntimeDatabaseType(
      inferDatabaseType(argUrl, args.dbType),
    );
    const db = await getDatabaseInstance({ type: databaseType, url: argUrl });
    return {
      db,
      source: 'argument',
      displayUrl: redactConnectionString(argUrl),
      databaseType,
    };
  }

  const envUrl = process.env.SMRT_DEV_DB_URL?.trim();
  if (envUrl && envUrl !== ':memory:') {
    const databaseType = toRuntimeDatabaseType(
      inferDatabaseType(envUrl, args.dbType),
    );
    const db = await getDatabaseInstance({ type: databaseType, url: envUrl });
    return {
      db,
      source: 'environment',
      displayUrl: redactConnectionString(envUrl),
      databaseType,
    };
  }

  const config = loadCliDatabaseConfig();
  const configUrl = config?.database?.url?.trim();
  if (configUrl && configUrl !== ':memory:') {
    const databaseType = toRuntimeDatabaseType(
      config.database?.type || inferDatabaseType(configUrl, args.dbType),
    );
    const db = await getDatabaseInstance({
      type: databaseType,
      url: configUrl,
    });
    return {
      db,
      source: 'config',
      displayUrl: redactConnectionString(configUrl),
      databaseType,
    };
  }

  return { db: null, source: 'none', displayUrl: '', databaseType: null };
}

interface DatabaseConfigLike {
  database?: { type?: string; url?: string };
}

function loadCliDatabaseConfig(): DatabaseConfigLike {
  try {
    // Cosmiconfig is resolved from the server's cwd (the project the agent is
    // working in); a missing or invalid config falls back to the defaults.
    const config = getPackageConfig(
      'cli',
      DEFAULT_CLI_DATABASE as unknown as Record<string, unknown>,
    );
    const database = (config as DatabaseConfigLike).database;
    if (database && typeof database.url === 'string') {
      return { database };
    }
    return {};
  } catch {
    return {};
  }
}

async function getDatabaseInstance(options: {
  type: RuntimeDatabaseType;
  url: string;
}): Promise<DatabaseInterface> {
  return getDatabase(options);
}

type MaybeCloseableDatabase = {
  close?: () => unknown | Promise<unknown>;
  client?: {
    close?: () => unknown | Promise<unknown>;
    end?: () => unknown | Promise<unknown>;
  };
};

/**
 * Best-effort close of a resolved connection. Never throws; diagnostics must
 * not fail because cleanup hiccuped.
 */
export async function closeRuntimeConnection(db: unknown): Promise<void> {
  if (!db || typeof db !== 'object') return;
  const closeable = db as MaybeCloseableDatabase;
  const close =
    closeable.close ?? closeable.client?.end ?? closeable.client?.close;
  if (typeof close !== 'function') return;
  try {
    await close.call(closeable.close ? closeable : closeable.client);
  } catch {
    // Cleanup failures are not diagnostic failures.
  }
}
