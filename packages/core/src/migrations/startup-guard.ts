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
  options: MigrateRecordOptions = {},
): Promise<void> {
  // Tests normally use the quiet exemption. Production-mode tests can still
  // exercise the strict policy with an ordinary (unmarked) database handle.
  if (
    (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') ||
    isPreparedTestDatabase(db)
  )
    return;
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
