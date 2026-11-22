import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { DatabaseError } from '../errors.js';
import { getVerificationKey } from '../table-cache.js';
import { isPreparedTestDatabase } from '../testing/database-exemption.js';
import {
  BUILD_MANIFEST_ENV,
  registeredBuildSchema,
  resolveBuildSchema,
} from './build-schema.js';
import {
  type MigrateRecordOptions,
  readLastMigrateRecord,
} from './migrate-record.js';
import { runtimeManagedDatabaseDeclaration } from './runtime-managed-database.js';

const logger = createLogger({ level: 'info' });
// Keep in-flight work too: concurrent first queries share the same read.
// Rejections are removed so a refusal never becomes a successful start.
// Each entry remembers the registered build it was checked under: a build
// registered after it (the app's generated build module loading after an
// early query) means the answer must be worked out again.
const starts = new Map<
  string,
  { build: object | undefined; start: Promise<void> }
>();

/** Env switch that turns on wait mode; the value is the total timeout in ms. */
export const MIGRATION_WAIT_TIMEOUT_ENV = 'SMRT_MIGRATION_WAIT_TIMEOUT_MS';
export const DEFAULT_MIGRATION_WAIT_INITIAL_DELAY_MS = 2_000;
export const DEFAULT_MIGRATION_WAIT_MAX_DELAY_MS = 15_000;

/**
 * Opt-in wait mode for the guard (#5530). A second workload that starts while
 * another workload's init container migrates would otherwise crash-loop on
 * `DB_MIGRATION_REQUIRED`. Only that error is retried, with exponential
 * backoff; once the next wait would pass `timeoutMs` the original error is
 * rethrown unchanged.
 */
export interface MigrationWaitOptions {
  /** Total time to wait for the migration before the guard's error is thrown. */
  timeoutMs: number;
  /** First retry delay. Default 2000. */
  initialDelayMs?: number;
  /** Cap for the doubling delay. Default 15000. */
  maxDelayMs?: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests. */
  now?: () => number;
}

export interface StartupGuardOptions extends MigrateRecordOptions {
  /** Wait for the migration instead of failing fast. Overrides the env switch. */
  wait?: MigrationWaitOptions;
}

/** Wait settings from `SMRT_MIGRATION_WAIT_TIMEOUT_MS`; unset, invalid or 0 means fail fast. */
export function migrationWaitFromEnv(
  env: Record<string, string | undefined> = typeof process === 'undefined'
    ? {}
    : process.env,
): MigrationWaitOptions | undefined {
  const raw = env[MIGRATION_WAIT_TIMEOUT_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const timeoutMs = Number.parseInt(raw, 10);
  return timeoutMs > 0 ? { timeoutMs } : undefined;
}

/**
 * SELECT-only startup gate, once per database per process. Compares the
 * build's stamp (`resolveBuildSchema()`: the build module the app's generated
 * registration loads, the file named by `SMRT_BUILD_MANIFEST`, or the project
 * manifest under the working directory) with the last migrate record. What
 * the process has imported does not matter. Never call from system bootstrap,
 * migration, or diagnostic paths.
 */
export async function assertDatabaseMigratedForBuild(
  db: DatabaseInterface,
  options: StartupGuardOptions = {},
): Promise<void> {
  const { wait: explicitWait, ...recordOptions } = options;
  const wait = explicitWait ?? migrationWaitFromEnv();
  // A timeout that is not a positive finite number can never be exceeded, so
  // it means fail fast rather than an endless wait.
  if (!wait || !Number.isFinite(wait.timeoutMs) || wait.timeoutMs <= 0)
    return assertOnce(db, recordOptions);

  const timeoutMs = wait.timeoutMs;
  const maxDelayMs = wait.maxDelayMs ?? DEFAULT_MIGRATION_WAIT_MAX_DELAY_MS;
  const now = wait.now ?? Date.now;
  const sleep =
    wait.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let delay = wait.initialDelayMs ?? DEFAULT_MIGRATION_WAIT_INITIAL_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      await assertOnce(db, recordOptions);
      if (attempt > 1) {
        logger.info('Database migration landed; continuing startup', {
          attempts: attempt,
          waitedMs: now() - startedAt,
        });
      }
      return;
    } catch (error) {
      if (!isMigrationRequired(error)) throw error;
      const waitedMs = now() - startedAt;
      if (waitedMs + delay > timeoutMs) throw error;
      logger.warn('Waiting for database migration before starting', {
        attempt,
        retryInMs: delay,
        waitedMs,
        timeoutMs,
        reason: error instanceof Error ? error.message : String(error),
      });
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

function isMigrationRequired(error: unknown): boolean {
  return (
    error instanceof DatabaseError &&
    (error as { code?: string }).code === 'DB_MIGRATION_REQUIRED'
  );
}

async function assertOnce(
  db: DatabaseInterface,
  options: MigrateRecordOptions,
): Promise<void> {
  // Tests normally use the quiet exemption. Production-mode tests can still
  // exercise the strict policy with an ordinary (unmarked) database handle.
  if (
    (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') ||
    isPreparedTestDatabase(db)
  )
    return;
  // A runtime-managed database builds its own schema and never has a migrate
  // record; its opener declared that, with an owner and a reason. Only this
  // comparison is skipped: callers still verify table existence.
  if (runtimeManagedDatabaseDeclaration(db)) return;
  const key = getVerificationKey(db);
  const build = registeredBuildSchema();
  let entry = starts.get(key);
  if (!entry || entry.build !== build) {
    entry = { build, start: check(db, options) };
    starts.set(key, entry);
  }
  try {
    await entry.start;
  } catch (error) {
    if (starts.get(key) === entry) starts.delete(key);
    throw error;
  }
}

async function check(
  db: DatabaseInterface,
  options: MigrateRecordOptions,
): Promise<void> {
  const build = resolveBuildSchema();
  const expected = build?.fingerprint ?? null;
  const last = await readLastMigrateRecord(db, options);
  const found = last.state === 'recorded' ? last.record.fingerprint : null;
  const message = expected
    ? `Database migration check: expected ${expected.slice(0, 12)}, ` +
      `found ${found ? found.slice(0, 12) : 'no migrate record'}. `
    : build
      ? `Database migration check: this build carries no schema fingerprint (${build.missingReason ?? 'not stamped'}; ${build.source}). `
      : "Database migration check: no build schema found. Load the app's generated registration " +
        '(src/lib/server/smrt-register.ts, .smrt/register.js or .smrt/runtime/register.js, which import .smrt/build-schema.js) ' +
        `before the first query, or set ${BUILD_MANIFEST_ENV} to the build's .smrt/manifest.json. `;
  // The override is audited even when the fingerprints already match.
  if (
    typeof process !== 'undefined' &&
    process.env.SMRT_ALLOW_UNMIGRATED_START === '1'
  ) {
    logger.warn(
      `${message}Check overridden by SMRT_ALLOW_UNMIGRATED_START=1. Run smrt db:migrate before starting this build.`,
    );
    return;
  }
  if (expected && found === expected) return;
  const recovery =
    (expected
      ? 'Run smrt db:migrate before starting this build. '
      : 'smrt db:migrate stamps the database for a build; this process cannot tell which build it is. ') +
    'A restarted old copy or code rolled back without its database is refused for the same reason.';
  // Match the CLI's default environment convention. An explicitly named
  // production (or other deployment environment) fails closed.
  const environment =
    typeof process === 'undefined'
      ? 'development'
      : (process.env.NODE_ENV ?? 'development');
  if (environment === 'development') {
    logger.warn(`${message}${recovery} Continuing in development mode.`);
    return;
  }
  throw new DatabaseError(`${message}${recovery}`, 'DB_MIGRATION_REQUIRED', {
    expected,
    found,
    build: build?.source ?? null,
  });
}
