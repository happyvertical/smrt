/**
 * First-run schema creation and upgrade for the local profile (smrt#4835).
 *
 * The local runtime sets up its own database on start instead of exiting with
 * `DB_SCHEMA_MISSING`. This is NOT a second schema creator: the framework step
 * is `migrateSmrtSchemas` from `@happyvertical/smrt-core/migrations`, the same
 * orchestration (`ObjectRegistry` -> `generateSchemaDiff` ->
 * `MigrationTracker.applyAll`, recorded in `_smrt_schema_migrations`) that
 * `smrt db:migrate` builds on. On an up-to-date database its diff is empty and
 * nothing is written, so a second start is a no-op.
 *
 * The caller (`initializeLocalApplicationRuntime`) owns the surrounding
 * guarantees and this module relies on them: custody, the initialization lock
 * and (for the web process) the writer lease are already held, so two starts
 * cannot race, and the deployed profiles never reach this code.
 *
 * Atomicity. On a first run the framework step and the application's
 * `prepareDatabase` step run inside ONE database transaction; the migration
 * tracker's own batch becomes a savepoint within it, and its `failed`
 * bookkeeping row is rolled back with everything else. A failure in either
 * step therefore rolls the database back to what it was, and when the attempt
 * itself created the database file the caller also removes it (and SQLite's
 * side files), so a failed first run leaves no database at all. On an
 * upgrade the framework batch is atomic by itself (one DDL transaction) and
 * the application's step has a transaction of its own; see `prepareLocalSchema`.
 */

import { randomBytes } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import {
  assertMigrationAccepted,
  formatMigrationRefusal,
  MigrationRefusedError,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { LocalRuntimePaths } from './index.js';
import { BOOTSTRAP_TABLE } from './local-custody.js';
import { LocalRuntimeError } from './local-runtime-error.js';

/** Table the migration tracker keeps (`MigrationTracker`); framework-owned. */
const MIGRATION_TRACKER_TABLE = '_smrt_schema_migrations';

/**
 * Fixed, secret-free surface for a failed first-run schema creation or
 * upgrade. No path, SQL or driver text: the original error is retained only
 * as a non-enumerable `cause`.
 */
export const SCHEMA_CREATION_FAILED_MESSAGE =
  'The local database schema could not be created or upgraded (schema_creation_failed); the database was left as it was. Inspect the private application logs.';

/** Fixed, secret-free surface for a failed application `prepareDatabase`. */
export const MIGRATION_FAILED_MESSAGE =
  'The application migration step failed; run pnpm app:setup and inspect the private migration logs.';

/** What the runtime hands the application's `prepareDatabase` step. */
export interface PrepareDatabaseContext {
  /**
   * The database to prepare. When the runtime creates the schema this is the
   * transaction handle: every write the step makes commits or rolls back
   * together with the framework schema.
   */
  readonly db: DatabaseInterface;
  /** Runtime profile; schema creation and the paths are local-only. */
  readonly profile: 'local' | 'self-hosted' | 'cloud';
  /** Resolved local data paths; `null` on a deployed profile. */
  readonly paths: LocalRuntimePaths | null;
  /**
   * True when this start found no framework schema and no earlier runtime
   * initialization in the database (an empty data directory). Always false on
   * a deployed profile.
   */
  readonly firstRun: boolean;
  /**
   * The framework's migration runner (`migrateSmrtSchemas`), bound to
   * {@link PrepareDatabaseContext.db}. Idempotent; call it again after the
   * step registers further `@smrt()` objects. Inside the step's transaction it
   * creates missing tables; reshaping an existing table is `smrt db:migrate`
   * (a transaction handle cannot read an existing table's live schema).
   * Rejects on a deployed profile, which migrates through `smrt db:migrate`.
   */
  migrateSchemas(): Promise<{ readonly applied: boolean }>;
}

/** The context of the local profile, where the paths are always present. */
export interface LocalPrepareDatabaseContext extends PrepareDatabaseContext {
  readonly profile: 'local';
  readonly paths: NonNullable<PrepareDatabaseContext['paths']>;
}

/**
 * The application's own database step. Runs on EVERY local start, after the
 * framework schema, inside the same lock and transaction, so it must be
 * idempotent. A caller that only needs the database may take `(db)` alone.
 */
export type LocalPrepareDatabase = (
  db: DatabaseInterface,
  context: LocalPrepareDatabaseContext,
) => Promise<void>;

export interface PrepareLocalSchemaInput {
  readonly db: DatabaseInterface;
  readonly paths: LocalPrepareDatabaseContext['paths'];
  readonly appId: string;
  /** Create and upgrade the framework schema (otherwise only run the hook). */
  readonly createSchema: boolean;
  readonly prepareDatabase?: LocalPrepareDatabase;
}

/**
 * A step failed. `error` is the public, redacted failure; `discard` says the
 * transaction rolled the database back so the caller may remove a file this
 * attempt created.
 */
export class LocalSchemaStepFailure extends Error {
  constructor(
    readonly error: LocalRuntimeError,
    readonly discard: boolean,
  ) {
    super(error.message);
    this.name = 'LocalSchemaStepFailure';
  }
}

export function migrationFailed(cause: unknown): LocalRuntimeError {
  return withCause(
    new LocalRuntimeError('migration_failed', MIGRATION_FAILED_MESSAGE),
    cause,
  );
}

export function schemaCreationFailed(cause: unknown): LocalRuntimeError {
  return withCause(
    new LocalRuntimeError(
      'schema_creation_failed',
      SCHEMA_CREATION_FAILED_MESSAGE,
    ),
    cause,
  );
}

/**
 * The framework step was refused: smrt held the whole upgrade back and applied
 * nothing. Unlike the other failures this one is named, because the reader (the
 * app's user, who cannot run `smrt db:migrate`) needs to know what stopped. The
 * message carries table, column, reason, row counts, package and release stops
 * and what was held back (the same text `smrt db:migrate` prints): schema names
 * and counts only, no path, SQL or driver text.
 */
export function schemaMigrationRefused(
  refusal: MigrationRefusedError,
): LocalRuntimeError {
  return withCause(
    new LocalRuntimeError(
      'schema_migration_refused',
      `The local database schema was not upgraded, and nothing was changed. ${formatMigrationRefusal(refusal.result)}`,
    ),
    refusal,
  );
}

/** A refused migrate keeps its reasons; any other framework failure is redacted. */
function frameworkFailure(failure: unknown): LocalRuntimeError {
  return failure instanceof MigrationRefusedError
    ? schemaMigrationRefused(failure)
    : schemaCreationFailed(failure);
}

function withCause(failure: LocalRuntimeError, cause: unknown) {
  Object.defineProperty(failure, 'cause', {
    value: cause,
    configurable: true,
  });
  return failure;
}

/** True before this start has any framework schema or runtime table. */
async function isFirstRun(db: DatabaseInterface): Promise<boolean> {
  const result = await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
    MIGRATION_TRACKER_TABLE,
    BOOTSTRAP_TABLE,
  );
  return result.rows.length === 0;
}

/**
 * The orchestrator's default id is timestamped to the second, so two starts
 * in the same second with different pending changes (a crash-restart loop)
 * would collide on a checksum mismatch. A random suffix keeps every run's
 * record distinct.
 */
function uniqueMigrationName(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\..*$/, '');
  return `${stamp}_${randomBytes(4).toString('hex')}_smrt_schema_sync`;
}

function contextFor(
  db: DatabaseInterface,
  input: PrepareLocalSchemaInput,
  firstRun: boolean,
): LocalPrepareDatabaseContext {
  return Object.freeze({
    db,
    profile: 'local' as const,
    paths: input.paths,
    firstRun,
    migrateSchemas: async () => {
      const result = await migrateSmrtSchemas({
        db,
        packageName: input.appId,
        engineHint: 'sqlite',
        name: uniqueMigrationName(),
      });
      // A refused run also reports `applied: false`; never read that as
      // "nothing to do". Fail the step and say what stopped.
      assertMigrationAccepted(result);
      return { applied: result.applied };
    },
  });
}

/**
 * Create or upgrade the framework schema, then run the application's step,
 * all in one transaction. Throws {@link LocalSchemaStepFailure}.
 *
 * Without `createSchema` this is the historical behaviour: the application's
 * step runs directly on the database (operator tooling that migrates through
 * another path, such as `smrt app setup` spawning `smrt db:migrate`, needs
 * that: a separate process cannot write while this one holds a transaction).
 */
export async function prepareLocalSchema(
  input: PrepareLocalSchemaInput,
): Promise<void> {
  const { db } = input;
  const firstRun = await isFirstRun(db);

  if (!input.createSchema) {
    try {
      await input.prepareDatabase?.(db, contextFor(db, input, firstRun));
    } catch (failure) {
      throw new LocalSchemaStepFailure(
        failure instanceof MigrationRefusedError
          ? schemaMigrationRefused(failure)
          : migrationFailed(failure),
        false,
      );
    }
    return;
  }

  if (typeof db.transaction !== 'function') {
    throw new LocalSchemaStepFailure(
      schemaCreationFailed(
        new Error('The database adapter has no transaction support.'),
      ),
      false,
    );
  }

  if (!firstRun) {
    // Upgrade or steady state. A transaction handle cannot read the live
    // schema of an existing table (`getTableSchema` is not on it), so the
    // framework step runs on the database itself: the tracker applies its
    // batch as ONE atomic DDL transaction, and a failed batch changes no
    // table. The application's step then runs in a transaction of its own.
    try {
      await contextFor(db, input, firstRun).migrateSchemas();
    } catch (failure) {
      throw new LocalSchemaStepFailure(frameworkFailure(failure), false);
    }
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as DatabaseInterface;
        await input.prepareDatabase?.(
          scoped,
          contextFor(scoped, input, firstRun),
        );
      });
    } catch (failure) {
      throw new LocalSchemaStepFailure(
        failure instanceof MigrationRefusedError
          ? schemaMigrationRefused(failure)
          : migrationFailed(failure),
        false,
      );
    }
    return;
  }

  // First run: only new tables exist to be created, which a transaction
  // handle can plan, so the framework step and the application's step share
  // ONE transaction. The tracker's batch becomes a savepoint inside it and
  // its `failed` bookkeeping row rolls back with everything else.
  let stage: 'framework' | 'application' = 'framework';
  try {
    await db.transaction(async (tx) => {
      const scoped = tx as unknown as DatabaseInterface;
      await contextFor(scoped, input, firstRun).migrateSchemas();
      stage = 'application';
      await input.prepareDatabase?.(
        scoped,
        contextFor(scoped, input, firstRun),
      );
    });
  } catch (failure) {
    throw new LocalSchemaStepFailure(
      failure instanceof MigrationRefusedError
        ? schemaMigrationRefused(failure)
        : stage === 'framework'
          ? schemaCreationFailed(failure)
          : migrationFailed(failure),
      true,
    );
  }
}

/**
 * Remove a database this attempt created, with SQLite's side files. Only
 * called after a rolled-back first run, with the database closed.
 */
export async function discardCreatedDatabase(
  databasePath: string,
): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = `${databasePath}${suffix}`;
    try {
      if ((await lstat(path)).isFile()) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Whether a database file is already present (call before opening it). */
export async function databaseFileExists(
  databasePath: string,
): Promise<boolean> {
  try {
    await lstat(databasePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
