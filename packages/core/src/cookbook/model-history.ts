/** Host-owned app schema revision journal, provisioned by tracked migrations. */

import type { Cookbook } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { MigrationTracker } from '../migrations/tracker.js';
import { appModelChangesMigrations } from '../system/app-model-changes.js';
import { runSerializedAgainstSystemTableBootstrap } from '../system/bootstrap.js';
import { getDatabaseEngine } from '../system/compatibility.js';
import { toSafeInteger } from '../utils/safe-integer.js';
import type { EngineCatalog } from './engine/types.js';
import type { AppModelEditReceipt } from './model-editor.js';

/** Inert host binding and first-completion projection recipe; never authority. */
export interface AppModelOperation {
  binding: Record<string, unknown>;
  result?: Record<string, unknown>;
  catalog?: EngineCatalog;
  approvalId?: string;
}
export interface AppModelChange {
  revision: number;
  requestId: string;
  actor: string;
  command: string;
  before: Cookbook;
  after: Cookbook;
  status: 'pending' | 'applied';
  /**
   * The revision was abandoned by an operator while pending: it is completed
   * with its `before` document as `after`, never applied, and never an undo
   * target. Its command and actor stay for audit.
   */
  abandoned?: true;
  undoes?: number;
  elapsedMs?: number;
  operation?: AppModelOperation;
  receipt?: AppModelEditReceipt;
  result?: Record<string, unknown>;
}
/** One application/tenant binding per store. append must atomically check the latest revision. */
export interface AppModelHistoryStore {
  readonly supportsDurableOperations?: boolean;
  /**
   * Every revision in order. `{ receipts: false }` may leave out `receipt` and
   * `result` (each holds a full projection); the editor reads that way.
   */
  read(options?: { receipts?: boolean }): Promise<AppModelChange[]>;
  /** The latest revision without receipt/result, or undefined. Optional; falls back to read(). */
  latest?(): Promise<AppModelChange | undefined>;
  /** The revision for a request id, with receipt and result. Optional; falls back to read(). */
  find?(requestId: string): Promise<AppModelChange | undefined>;
  append(change: AppModelChange, expectedRevision: number): Promise<void>;
  complete(
    revision: number,
    elapsedMs: number,
    receipt?: AppModelEditReceipt,
    result?: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Abandon the pending revision `revision` (see {@link abandonAppModelRevision}).
   * Optional for custom stores; the default store implements it.
   */
  abandon?(
    revision: number,
    by: { actor: string; reason?: string },
  ): Promise<void>;
  /** PostgreSQL revision CAS and application DDL must share this locked transaction. */
  transaction?<T>(
    work: (store: AppModelHistoryStore, db: DatabaseInterface) => Promise<T>,
  ): Promise<T>;
}

/**
 * The `append` of every store {@link createAppModelHistory} made. A store
 * writes the journal (`_smrt_app_model_changes`) when its `append` is one of
 * these, so a wrapper that delegates to a journal store counts as one.
 */
const JOURNAL_APPENDS = new WeakSet<object>();

/**
 * Whether `store` appends to the app model journal. The retire step (#5005)
 * reads that journal to learn which tables run-time lists use; a store that
 * writes elsewhere would let a whole-schema migrate in another process drop
 * a list's table.
 */
export function isAppModelJournalStore(store: AppModelHistoryStore): boolean {
  return (
    typeof store.append === 'function' && JOURNAL_APPENDS.has(store.append)
  );
}

export async function createAppModelHistory(options: {
  db: DatabaseInterface;
  application: string;
  tenantId: string;
}): Promise<AppModelHistoryStore> {
  const { db, application, tenantId } = options;
  const engine = getDatabaseEngine(db);
  if (!['sqlite', 'postgres'].includes(engine) || !application || !tenantId)
    throw new Error(
      'The default model history requires SQLite or PostgreSQL and explicit application/tenant identities',
    );
  await runSerializedAgainstSystemTableBootstrap(db, engine, async (db) => {
    const tracker = new MigrationTracker({ db, engineHint: engine });
    const results = await tracker.applyAll(
      appModelChangesMigrations(engine as 'sqlite' | 'postgres'),
      { postgresSafe: false, reconcile: false },
    );
    if (results.some((r) => !r.success))
      throw new Error('Could not migrate the app model history');
    if (engine === 'postgres') {
      const columns = await db.query(
        "SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '_smrt_app_model_changes' AND column_name = 'tenant_id'",
      );
      if (columns.rows[0]?.data_type !== 'uuid')
        throw new Error(
          'APP_MODEL_HISTORY_MIGRATION_REQUIRED: validate and migrate legacy tenant identities to UUID before serving',
        );
    }
  });
  const bound = (db: DatabaseInterface): AppModelHistoryStore => {
    const store = journalStore(db);
    JOURNAL_APPENDS.add(store.append);
    return store;
  };
  // Receipts and results each hold a full projection; the light column list
  // keeps them out of the editor's reads, with the abandoned marker computed.
  const LIGHT = `revision, request_id, actor, command, before_doc, after_doc, status, undoes, elapsed_ms, operation_json, CASE WHEN result_json LIKE '{"abandoned":%' THEN 1 ELSE 0 END AS abandoned_marker`;
  const toChange = (row: Record<string, unknown>): AppModelChange => ({
    revision: toSafeInteger(row.revision, 'App model revision'),
    requestId: String(row.request_id),
    actor: String(row.actor),
    command: String(row.command),
    before: JSON.parse(String(row.before_doc)),
    after: JSON.parse(String(row.after_doc)),
    status: row.status as AppModelChange['status'],
    ...(Number(row.abandoned_marker) === 1 || abandonedResult(row.result_json)
      ? { abandoned: true as const }
      : {}),
    ...(row.operation_json
      ? { operation: JSON.parse(String(row.operation_json)) }
      : {}),
    ...(row.receipt_json
      ? { receipt: JSON.parse(String(row.receipt_json)) }
      : {}),
    ...(row.result_json ? { result: JSON.parse(String(row.result_json)) } : {}),
    ...(row.undoes != null
      ? { undoes: toSafeInteger(row.undoes, 'Undone revision') }
      : {}),
    ...(row.elapsed_ms != null
      ? {
          elapsedMs:
            engine === 'postgres'
              ? toSafeInteger(row.elapsed_ms, 'App model elapsed milliseconds')
              : Number(row.elapsed_ms),
        }
      : {}),
  });
  const journalStore = (db: DatabaseInterface): AppModelHistoryStore => ({
    supportsDurableOperations: true,
    async read(options) {
      const { rows } = await db.query(
        `SELECT ${options?.receipts === false ? LIGHT : '*'} FROM _smrt_app_model_changes WHERE application = ? AND tenant_id = ? ORDER BY revision`,
        [application, tenantId],
      );
      return rows.map(toChange);
    },
    async latest() {
      const { rows } = await db.query(
        `SELECT ${LIGHT} FROM _smrt_app_model_changes WHERE application = ? AND tenant_id = ? ORDER BY revision DESC LIMIT 1`,
        [application, tenantId],
      );
      return rows[0] ? toChange(rows[0]) : undefined;
    },
    async find(requestId) {
      const { rows } = await db.query(
        `SELECT * FROM _smrt_app_model_changes WHERE application = ? AND tenant_id = ? AND request_id = ?`,
        [application, tenantId, requestId],
      );
      return rows[0] ? toChange(rows[0]) : undefined;
    },
    async append(change, expectedRevision) {
      if (
        !Number.isSafeInteger(change.revision) ||
        change.revision !== expectedRevision + 1 ||
        !Number.isSafeInteger(expectedRevision)
      )
        throw new Error('MODEL_EDIT_CONFLICT: invalid revision');
      // One insert statement is the CAS even across two SQLite connections.
      const { rows } = await db.query(
        `INSERT INTO _smrt_app_model_changes
        (application, tenant_id, revision, request_id, actor, command, before_doc, after_doc, status, undoes, operation_json)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
        WHERE COALESCE((SELECT MAX(revision) FROM _smrt_app_model_changes WHERE application = ? AND tenant_id = ?), 0) = ?
        AND NOT EXISTS (SELECT 1 FROM _smrt_app_model_changes WHERE application = ? AND tenant_id = ? AND status = 'pending')
        ON CONFLICT DO NOTHING RETURNING revision`,
        [
          application,
          tenantId,
          change.revision,
          change.requestId,
          change.actor,
          change.command,
          JSON.stringify(change.before),
          JSON.stringify(change.after),
          change.undoes ?? null,
          change.operation ? JSON.stringify(change.operation) : null,
          application,
          tenantId,
          expectedRevision,
          application,
          tenantId,
        ],
      );
      if (!rows.length)
        throw new Error(
          'MODEL_EDIT_CONFLICT: history advanced or activation is pending',
        );
    },
    async complete(revision, elapsedMs, receipt, result) {
      const { rows } = await db.query(
        `UPDATE _smrt_app_model_changes SET status = 'applied', elapsed_ms = ?, receipt_json = ?, result_json = ? WHERE application = ? AND tenant_id = ? AND revision = ? AND status = 'pending' RETURNING revision`,
        [
          engine === 'postgres'
            ? toSafeInteger(
                Math.round(elapsedMs),
                'App model elapsed milliseconds',
              )
            : elapsedMs,

          receipt ? JSON.stringify(receipt) : null,
          result ? JSON.stringify(result) : null,
          application,
          tenantId,
          revision,
        ],
      );
      if (rows.length !== 1) {
        const existing = (
          await db.query(
            `SELECT status FROM _smrt_app_model_changes WHERE application = ? AND tenant_id = ? AND revision = ?`,
            [application, tenantId, revision],
          )
        ).rows[0];
        if (existing?.status !== 'applied')
          throw new Error('MODEL_EDIT_CONFLICT: missing pending revision');
        // Another completion already won. Never replace its first receipt/result.
      }
    },
    async abandon(revision, by) {
      if (!Number.isSafeInteger(revision) || !by.actor)
        throw new Error(
          'MODEL_ABANDON_INVALID: a revision and an actor are required',
        );
      // Completes the pending row as a no-op: its after document becomes its
      // before document, so no later read or boot applies the abandoned edit.
      // The journal schema allows only pending/applied; the marker is the result.
      const { rows } = await db.query(
        `UPDATE _smrt_app_model_changes SET status = 'applied', after_doc = before_doc, elapsed_ms = 0, receipt_json = NULL, result_json = ? WHERE application = ? AND tenant_id = ? AND revision = ? AND status = 'pending' RETURNING revision`,
        [
          JSON.stringify({
            abandoned: {
              actor: by.actor,
              ...(by.reason ? { reason: by.reason } : {}),
            },
          }),
          application,
          tenantId,
          revision,
        ],
      );
      if (rows.length !== 1)
        throw new Error(
          `MODEL_ABANDON_NOT_PENDING: revision ${revision} is not a pending revision`,
        );
    },
  });
  const store = bound(db);
  if (engine === 'postgres') {
    store.transaction = (work) =>
      runSerializedAgainstSystemTableBootstrap(db, engine, (tx) =>
        work(bound(tx), tx),
      );
    store.complete = (revision, elapsedMs, receipt, result) =>
      runSerializedAgainstSystemTableBootstrap(db, engine, async (tx) => {
        const scoped = bound(tx);
        const latest = await scoped.latest!();
        if (latest?.revision !== revision)
          throw new Error('MODEL_EDIT_CONFLICT: history advanced');
        if (latest.status === 'pending')
          await scoped.complete(revision, elapsedMs, receipt, result);
      });
  }
  return store;
}

function abandonedResult(value: unknown): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(String(value));
    return !!parsed && typeof parsed === 'object' && 'abandoned' in parsed;
  } catch {
    return false;
  }
}

/**
 * Operator recovery for a pending revision that can never apply (its
 * migration is refused, or its publication keeps failing). Run it while no
 * editor for this application and tenant is serving, then open the editor
 * again: boot no longer replays the abandoned edit. Nothing is dropped; any
 * column the failed attempt added stays unused.
 */
export async function abandonAppModelRevision(options: {
  db: DatabaseInterface;
  application: string;
  tenantId: string;
  revision: number;
  actor: string;
  reason?: string;
}): Promise<void> {
  const store = await createAppModelHistory(options);
  const run = (target: AppModelHistoryStore) =>
    target.abandon!(options.revision, {
      actor: options.actor,
      ...(options.reason ? { reason: options.reason } : {}),
    });
  await (store.transaction
    ? store.transaction((scoped) => run(scoped))
    : run(store));
}

/** Compatibility name retained for existing local hosts. */
export const createSqliteAppModelHistory = createAppModelHistory;
