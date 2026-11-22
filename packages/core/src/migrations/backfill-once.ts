/**
 * A data step that must not be applied twice, run as one unit with its
 * `_smrt_backfills` marker. Internal to core: the money minor-units rescale
 * (`minor-units.ts`) is its caller.
 *
 * `BackfillTracker.runIfPending` writes its marker after the work, so whatever
 * fails between the two is done again; that is fine only for work that is safe
 * to repeat. A rescale multiplies, so it uses this instead: the work and the
 * marker commit together or not at all, and two runners are serialized.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { abortJoinedDuckDbTransaction } from '../cascade.js';
import { getDatabaseEngine } from '../system/compatibility.js';
import { BackfillTracker } from './backfill-tracker.js';

/**
 * First key of the advisory lock one backfill takes on PostgreSQL; the second
 * is the hash of its name. Kept apart from the framework's other advisory
 * locks (`hashtext('smrt')`), which a backfill may run under.
 */
const BACKFILL_LOCK_CLASS = "hashtext('smrt:backfill')";

export interface BackfillOnceOptions {
  description?: string;
  packageName?: string;
  /** The engine, when the caller knows it better than the handle's URL. */
  engine?: string;
}

export type BackfillOnceOutcome<T> =
  | { ran: false; result: null }
  | { ran: true; result: T };

/**
 * Run `work` at most once, as one unit with the marker `name`.
 *
 * `work` runs inside a transaction and receives that transaction's handle.
 * Everything it writes through the handle commits together with the marker, or
 * not at all: a failure anywhere, in `work` or in recording the marker, leaves
 * the data and the marker as they were. Returns `{ ran: false }` when the
 * marker is already there.
 *
 * The transaction first claims the name (PostgreSQL: a transaction-level
 * advisory lock on it; SQLite: the database's write lock), then looks for the
 * marker again, so a runner that waited finds the work done. DuckDB has
 * neither lock; run-once holds there through DuckDB's own transaction
 * conflict: two transactions that both change the same table cannot both
 * commit, so the second runner's transaction fails and rolls back (and a
 * DuckDB file is open in one process at a time).
 *
 * On a transaction handle, the caller's transaction is the unit, and the work
 * and the marker also run in a nested scope of it (`transaction()` on the
 * handle: a savepoint on SQLite and PostgreSQL), rolled back before a failure
 * is returned: a caller that catches the failure and commits commits none of
 * the work. The original failure is the one returned, even when the rollback
 * of the nested scope fails too. A SQLite or PostgreSQL transaction handle
 * without nested scopes is refused before anything is written. DuckDB has no nested scope: a failure after the work
 * has written puts the caller's transaction in DuckDB's aborted state
 * (`abortJoinedDuckDbTransaction`), so it can only end by discarding the
 * work; a refusal before any write leaves it as it was.
 *
 * `options.engine` names the engine when the caller knows it (an engine hint);
 * otherwise the handle's own `engine`, then its URL, decide.
 */
export async function runBackfillOnceInTransaction<T>(
  db: DatabaseInterface,
  name: string,
  work: (db: DatabaseInterface) => Promise<T>,
  options: BackfillOnceOptions = {},
): Promise<BackfillOnceOutcome<T>> {
  if (!isRootDatabase(db)) return runClaimed(db, name, work, options, true);

  const tracker = new BackfillTracker({ db });
  // The table is created outside the transaction, so a rolled-back run does
  // not take it along, and an applied backfill costs one read.
  if (await tracker.isApplied(name)) return { ran: false, result: null };
  if (typeof db.transaction !== 'function') {
    throw new Error(
      `Backfill ${name} must run as one unit with its marker, and this database adapter has no transaction support.`,
    );
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as DatabaseInterface;
    BackfillTracker.inheritInitialization(scoped, db);
    return runClaimed(scoped, name, work, options, false);
  });
}

/** Claim, look again, work, record: all on `unit`. */
async function runClaimed<T>(
  unit: DatabaseInterface,
  name: string,
  work: (db: DatabaseInterface) => Promise<T>,
  options: BackfillOnceOptions,
  callerOwned: boolean,
): Promise<BackfillOnceOutcome<T>> {
  const engine = resolveEngine(unit, options.engine);
  if (
    callerOwned &&
    (engine === 'sqlite' || engine === 'postgres') &&
    typeof unit.transaction !== 'function'
  ) {
    // Without a nested scope, a failure part-way (a SQLite statement that
    // undoes only itself, or an adapter error before a statement is sent)
    // leaves the earlier writes in the caller's transaction, and a caller
    // that catches the error and commits keeps them without the marker.
    // Refuse before writing anything.
    throw new Error(
      `Backfill ${name} must run as one unit with its marker, and this ${engine === 'sqlite' ? 'SQLite' : 'PostgreSQL'} transaction handle cannot open a nested scope (no transaction()). Run it on the database handle, or on a transaction handle that supports nesting.`,
    );
  }
  const tracker = new BackfillTracker({ db: unit });
  await tracker.initialize();
  await claimInTransaction(unit, name, engine);
  if (await tracker.isApplied(name)) return { ran: false, result: null };

  const marker = {
    description: options.description,
    packageName: options.packageName,
  };
  const nested =
    callerOwned &&
    (engine === 'sqlite' || engine === 'postgres') &&
    typeof unit.transaction === 'function';
  if (!nested) {
    // Whether the work has sent anything but reads: until it has, a refusal
    // (a preflight that finds rows it would round) leaves nothing to undo.
    let wrote = false;
    const watched =
      callerOwned && engine === 'duckdb'
        ? watchWrites(unit, () => {
            wrote = true;
          })
        : unit;
    try {
      const result = await work(watched);
      wrote = true;
      await tracker.recordApplied(name, marker);
      return { ran: true, result };
    } catch (error) {
      // DuckDB has no nested scope. A failure that never reached the engine
      // (an adapter error before the marker insert) leaves the joined
      // transaction usable, and a caller that catches it could commit the
      // work without its marker: once the work has written, put the
      // transaction in DuckDB's aborted state, so it can only end by
      // discarding everything. A refusal before any write leaves the
      // caller's transaction as it was.
      if (callerOwned && engine === 'duckdb' && wrote)
        await abortJoinedDuckDbTransaction(
          unit,
          `backfill ${name} failed; this transaction cannot commit`,
        );
      throw error;
    }
  }

  // A nested scope of the caller's transaction: the handle's own savepoint,
  // which every adapter that has one supports (raw SAVEPOINT SQL is refused on
  // some transaction handles). Everything the work and the marker wrote is
  // undone when it fails, and the caller's transaction holds none of it.
  let original: { error: unknown } | undefined;
  try {
    const result = await (
      unit.transaction as NonNullable<DatabaseInterface['transaction']>
    )(async (scope) => {
      try {
        const inner = scope as unknown as DatabaseInterface;
        const value = await work(inner);
        await new BackfillTracker({ db: inner }).recordApplied(name, marker);
        return value;
      } catch (error) {
        original = { error };
        throw error;
      }
    });
    return { ran: true, result };
  } catch (error) {
    // When the nested scope's rollback fails as well (SQLite already rolled
    // back the whole transaction: "no such savepoint"), the work's own failure
    // is what the caller needs to see.
    throw original ? original.error : error;
  }
}

/** `db`, calling `onWrite` before any statement that is not a read. */
function watchWrites(
  db: DatabaseInterface,
  onWrite: () => void,
): DatabaseInterface {
  return new Proxy(db, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== 'query')
        return typeof value === 'function' ? value.bind(target) : value;
      return (sql: string, ...args: unknown[]) => {
        if (
          !/^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN|SHOW|DESCRIBE)\b/i.test(
            String(sql),
          )
        )
          onWrite();
        return (value as DatabaseInterface['query']).call(target, sql, ...args);
      };
    },
  });
}

/** The engine: the caller's hint, then a DuckDB handle's own name, then its URL. */
function resolveEngine(
  db: DatabaseInterface,
  hint: string | undefined,
): string {
  if (hint) return hint;
  // A DuckDB transaction handle on `:memory:` reads as SQLite by its URL.
  if ((db as { engine?: unknown }).engine === 'duckdb') return 'duckdb';
  return getDatabaseEngine(db);
}

/**
 * Make this transaction the only one working on `name` until it ends.
 *
 * PostgreSQL waits on a transaction-level advisory lock. SQLite takes the
 * write lock with a statement that changes no row: a transaction that only
 * read so far would otherwise let a second one read the same "not applied".
 */
async function claimInTransaction(
  unit: DatabaseInterface,
  name: string,
  engine: string,
): Promise<void> {
  if (engine === 'postgres') {
    await unit.query(
      `SELECT pg_advisory_xact_lock(${BACKFILL_LOCK_CLASS}, hashtext(?))`,
      name,
    );
  } else if (engine === 'sqlite') {
    await unit.query(
      'UPDATE _smrt_backfills SET name = name WHERE name = ? AND 1 = 0',
      name,
    );
  }
}

function isRootDatabase(db: DatabaseInterface): boolean {
  return typeof db.beginTransaction === 'function';
}
