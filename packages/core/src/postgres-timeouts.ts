/**
 * Runtime PostgreSQL timeout defaults for every pool SMRT constructs.
 *
 * `@happyvertical/sql` builds its pool as `new Pool({ connectionString, max })`
 * and nothing else, so an un-configured deployment inherits `pg`'s unbounded
 * defaults: `pool.connect()` waits forever once the pool is exhausted, a
 * runaway query holds its client indefinitely, and a request-scoped transaction
 * that stalls mid-flight holds its locks until the process dies (#2377).
 *
 * This module resolves a bounded set of timeouts and applies them at pool
 * construction. Three of them ride the connection URL: `pg` lifts
 * `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout`
 * out of the connection string's query parameters and sends them in the startup
 * packet, so they are session defaults on **every** client the pool opens,
 * including ones opened long after startup. The fourth, the connection
 * acquisition timeout, is a `pg` *pool* option with no connection-string
 * spelling; it is emitted as `connectionTimeoutMillis` on the options object
 * passed to `getDatabase()`, where `resolvePostgresConfig()` currently drops it.
 * It becomes live with no change here once the SDK forwards pool options
 * (happyvertical/sdk#1204).
 *
 * Scope: this is the *runtime* pool only. `smrt db:migrate` opens its own
 * connection through `@happyvertical/sql` directly and bounds its statements
 * with `SET LOCAL lock_timeout` / `statement_timeout` from
 * `migrations.postgres.*` (#2362); a migration therefore keeps its own, larger
 * budget even when it runs against a database whose runtime pool is bounded
 * here. The two read the same way on purpose — same string units, same
 * "unparseable falls back to the documented default" rule.
 *
 * @module
 */

/**
 * Runtime PostgreSQL timeouts, as accepted from configuration.
 *
 * Every value is either a number of milliseconds or a duration string with an
 * `ms`, `s`, `min`/`m`, or `h` suffix — the spelling
 * `migrations.postgres.lockTimeout` already uses (`'30s'`). `0` means
 * *disabled*, which is PostgreSQL's own semantic for the three server-side
 * timeouts and `pg`'s semantic for the connection timeout ("wait forever");
 * it is emitted explicitly so it overrides a server-side default rather than
 * silently inheriting one.
 *
 * @example
 * ```typescript
 * const db = await resolveDatabase({
 *   type: 'postgres',
 *   url: process.env.DATABASE_URL,
 *   timeouts: { statementTimeout: '10s', lockTimeout: '2s' },
 * });
 * ```
 */
export interface PostgresTimeoutConfig {
  /**
   * Milliseconds to wait for a pool client before failing the acquisition.
   *
   * Bounds `pool.connect()`, whose `pg` default of `0` waits forever — the
   * failure mode where one runaway query silently converts into a hung request
   * queue. Emitted as `connectionTimeoutMillis`.
   *
   * @default '10s'
   */
  connectionTimeout?: string | number;

  /**
   * Session `statement_timeout`: the ceiling on a single statement.
   *
   * @default '30s'
   */
  statementTimeout?: string | number;

  /**
   * Session `idle_in_transaction_session_timeout`: the ceiling on an open
   * transaction that is not currently executing a statement. This is the one
   * that releases locks held by a request that died between statements.
   *
   * @default '60s'
   */
  idleInTransactionSessionTimeout?: string | number;

  /**
   * Session `lock_timeout`: the ceiling on waiting for a lock.
   *
   * @default '10s'
   */
  lockTimeout?: string | number;
}

/**
 * Timeouts resolved to milliseconds, ready to emit.
 */
export interface ResolvedPostgresTimeouts {
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  idleInTransactionSessionTimeoutMs: number;
  lockTimeoutMs: number;
}

/**
 * Defaults applied to every runtime PostgreSQL pool.
 *
 * Chosen to bound the failure modes in #2377 without truncating legitimate
 * request work: a web request that needs more than 30 s of server time or
 * holds a transaction open for more than a minute is the pathology these
 * bound, not the workload. Long-running maintenance does not run on this pool
 * — `db:migrate` carries its own budget (#2362) — and any deployment that
 * disagrees raises or disables the value per key.
 */
export const DEFAULT_POSTGRES_TIMEOUTS: ResolvedPostgresTimeouts = {
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 30_000,
  idleInTransactionSessionTimeoutMs: 60_000,
  lockTimeoutMs: 10_000,
};

/**
 * Environment variable read for each timeout when configuration does not set
 * it.
 *
 * Deployments that only ever hand SMRT a `DATABASE_URL` (SvelteKit runtime
 * config, container env, serverless) have no object to put a `timeouts` key on,
 * so the environment is the configuration surface that actually reaches them.
 */
export const POSTGRES_TIMEOUT_ENV_VARS = {
  connectionTimeout: 'SMRT_PG_CONNECTION_TIMEOUT',
  statementTimeout: 'SMRT_PG_STATEMENT_TIMEOUT',
  idleInTransactionSessionTimeout: 'SMRT_PG_IDLE_IN_TRANSACTION_TIMEOUT',
  lockTimeout: 'SMRT_PG_LOCK_TIMEOUT',
} as const satisfies Record<keyof PostgresTimeoutConfig, string>;

/**
 * PostgreSQL connection-string parameters that carry a session timeout.
 *
 * `pg` reads exactly these three out of the connection string and puts them in
 * the startup packet (`Client.getStartupConf`), which is why the URL is the
 * delivery mechanism: the settings then apply to every client the pool opens,
 * not just the first, with no per-checkout `SET` round trip.
 */
const URL_TIMEOUT_PARAMS = {
  statementTimeoutMs: 'statement_timeout',
  idleInTransactionSessionTimeoutMs: 'idle_in_transaction_session_timeout',
  lockTimeoutMs: 'lock_timeout',
} as const;

/**
 * Parse a PostgreSQL timeout expressed as milliseconds or as the duration
 * string used in `smrt.config.js` into milliseconds.
 *
 * Accepts a bare number (milliseconds) or a number with an `ms`, `s`, `min`,
 * `m`, or `h` suffix. Returns `fallback` for `undefined`, empty, or
 * unparseable input so a typo degrades to the documented default instead of
 * silently disabling the timeout it was meant to impose.
 *
 * This is the same contract as `parsePostgresTimeoutMs` in
 * `@happyvertical/smrt-core/migrations` (#2362) — deliberately, so runtime and
 * migration timeouts are written the same way.
 *
 * @param value - Millisecond count or duration string
 * @param fallback - Value returned for missing or unparseable input
 * @returns Timeout in milliseconds
 */
export function parseTimeoutMs(
  value: string | number | undefined,
  fallback: number,
): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }

  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|min|m|h)?\s*$/i.exec(value);
  if (!match) {
    return fallback;
  }

  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const multiplier =
    unit === 'h'
      ? 3_600_000
      : unit === 'min' || unit === 'm'
        ? 60_000
        : unit === 's'
          ? 1000
          : 1;

  return Math.trunc(amount * multiplier);
}

/**
 * Resolve the effective runtime timeouts.
 *
 * Precedence, highest first: explicit configuration, then the matching
 * `SMRT_PG_*` environment variable, then {@link DEFAULT_POSTGRES_TIMEOUTS}.
 * A parameter already present in the connection URL beats all three, but that
 * is enforced where the URL is written ({@link applyPostgresTimeoutsToUrl}) —
 * an operator who spelled a timeout into the DSN keeps it.
 *
 * @param config - Timeouts from configuration
 * @param env - Environment to read (defaults to `process.env`)
 * @returns Timeouts in milliseconds
 */
export function resolvePostgresTimeouts(
  config: PostgresTimeoutConfig = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedPostgresTimeouts {
  const resolve = (
    key: keyof PostgresTimeoutConfig,
    fallback: number,
  ): number =>
    parseTimeoutMs(
      config[key] ?? env[POSTGRES_TIMEOUT_ENV_VARS[key]],
      fallback,
    );

  return {
    connectionTimeoutMs: resolve(
      'connectionTimeout',
      DEFAULT_POSTGRES_TIMEOUTS.connectionTimeoutMs,
    ),
    statementTimeoutMs: resolve(
      'statementTimeout',
      DEFAULT_POSTGRES_TIMEOUTS.statementTimeoutMs,
    ),
    idleInTransactionSessionTimeoutMs: resolve(
      'idleInTransactionSessionTimeout',
      DEFAULT_POSTGRES_TIMEOUTS.idleInTransactionSessionTimeoutMs,
    ),
    lockTimeoutMs: resolve(
      'lockTimeout',
      DEFAULT_POSTGRES_TIMEOUTS.lockTimeoutMs,
    ),
  };
}

/**
 * Does this configuration open a PostgreSQL connection?
 *
 * Deliberately narrower than `detectEngine()` from the DDL module: that helper
 * answers "which dialect do I generate SQL in" and folds `json` into `duckdb`,
 * while this one answers "may I rewrite this URL", which must be false for
 * every non-PostgreSQL adapter and must not pull the DDL strategy singletons
 * into the connection path.
 */
export function isPostgresTarget(url?: string, type?: string): boolean {
  if (typeof type === 'string') {
    const normalized = type.toLowerCase();
    if (
      normalized === 'postgres' ||
      normalized === 'postgresql' ||
      normalized === 'pg'
    ) {
      return true;
    }
    // An explicit non-PostgreSQL type wins over a URL that merely looks like
    // one; the adapter that will actually run is the one named here.
    return false;
  }

  const normalizedUrl = (url ?? '').toLowerCase();
  return (
    normalizedUrl.startsWith('postgres://') ||
    normalizedUrl.startsWith('postgresql://')
  );
}

/**
 * Write the session timeout parameters into a PostgreSQL connection URL.
 *
 * Parameters already present are left exactly as they are — an operator who
 * put `statement_timeout` in the DSN configured it on purpose, and the
 * per-parameter granularity means overriding one does not surrender the other
 * two to `pg`'s unbounded defaults.
 *
 * The query string is edited through `URLSearchParams` rather than `new URL()`
 * because a DSN whose password contains characters that are legal in libpq but
 * not in a WHATWG URL must survive this function untouched rather than throw
 * inside connection setup.
 *
 * @param url - PostgreSQL connection URL
 * @param timeouts - Resolved timeouts
 * @returns The URL with the missing timeout parameters appended (the same
 *   string when all three were already present)
 */
export function applyPostgresTimeoutsToUrl(
  url: string,
  timeouts: ResolvedPostgresTimeouts,
): string {
  const fragmentStart = url.indexOf('#');
  const fragment = fragmentStart === -1 ? '' : url.slice(fragmentStart);
  const withoutFragment =
    fragmentStart === -1 ? url : url.slice(0, fragmentStart);
  const queryStart = withoutFragment.indexOf('?');
  const base =
    queryStart === -1 ? withoutFragment : withoutFragment.slice(0, queryStart);
  const params = new URLSearchParams(
    queryStart === -1 ? '' : withoutFragment.slice(queryStart + 1),
  );

  let changed = false;
  for (const [key, param] of Object.entries(URL_TIMEOUT_PARAMS) as [
    keyof typeof URL_TIMEOUT_PARAMS,
    string,
  ][]) {
    if (params.has(param)) continue;
    params.set(param, String(Math.max(0, Math.trunc(timeouts[key]))));
    changed = true;
  }

  if (!changed) {
    return url;
  }

  return `${base}?${params.toString()}${fragment}`;
}

/**
 * Options object accepted and returned by
 * {@link applyPostgresRuntimeTimeouts}.
 */
export interface PostgresTimeoutAwareConfig {
  url?: string;
  type?: string;
  /** Runtime timeout overrides for this connection. */
  timeouts?: PostgresTimeoutConfig;
  /**
   * `pg` pool option emitted for PostgreSQL configurations. Present on the
   * result, not on the input.
   */
  connectionTimeoutMillis?: number;
  [key: string]: unknown;
}

/**
 * Bound a runtime database configuration before it reaches `getDatabase()`.
 *
 * Non-PostgreSQL configurations are returned unchanged (same reference), so
 * SQLite/DuckDB/JSON callers pay nothing and no file path is ever rewritten.
 *
 * For PostgreSQL the returned object carries a URL with the three session
 * timeouts and a `connectionTimeoutMillis` pool option. Callers that derive a
 * `dbid` from the URL must derive it from the **returned** URL: two configs
 * that differ only in their timeouts are different pools, and every call site
 * applying the same deterministic rewrite is what keeps them one pool when the
 * timeouts match.
 *
 * A PostgreSQL configuration given as discrete `host`/`port`/`database` fields
 * with no `url` has nowhere to carry the session parameters and receives only
 * `connectionTimeoutMillis`. No SMRT runtime path builds one — `resolveDatabase`
 * and `SmrtClass` both require a URL for non-SQLite engines — so this is a
 * documented edge, not a supported hole.
 *
 * The `timeouts` key is consumed here and not forwarded — `@happyvertical/sql`
 * would ignore it, and leaving it in the options object would make it look
 * like a supported adapter option.
 *
 * @param config - Database configuration bound for `getDatabase()`
 * @param env - Environment to read (defaults to `process.env`)
 * @returns Configuration with runtime timeouts applied
 */
export function applyPostgresRuntimeTimeouts(
  config: PostgresTimeoutAwareConfig,
  env: Record<string, string | undefined> = process.env,
): PostgresTimeoutAwareConfig {
  if (!isPostgresTarget(config.url, config.type)) {
    return config;
  }

  const { timeouts: configuredTimeouts, ...rest } = config;
  const timeouts = resolvePostgresTimeouts(configuredTimeouts, env);

  return {
    ...rest,
    ...(config.url
      ? { url: applyPostgresTimeoutsToUrl(config.url, timeouts) }
      : {}),
    connectionTimeoutMillis: timeouts.connectionTimeoutMs,
  };
}
