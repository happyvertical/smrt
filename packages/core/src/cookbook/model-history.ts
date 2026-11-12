/** Host-owned app schema revision journal, provisioned by tracked migrations. */

import type { Cookbook } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { createMigrationDefinition } from '../migrations/generator.js';
import { MigrationTracker } from '../migrations/tracker.js';
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
  undoes?: number;
  elapsedMs?: number;
  operation?: AppModelOperation;
  receipt?: AppModelEditReceipt;
  result?: Record<string, unknown>;
}
/** One application/tenant binding per store. append must atomically check the latest revision. */
export interface AppModelHistoryStore {
  readonly supportsDurableOperations?: boolean;
  read(): Promise<AppModelChange[]>;
  append(change: AppModelChange, expectedRevision: number): Promise<void>;
  complete(
    revision: number,
    elapsedMs: number,
    receipt?: AppModelEditReceipt,
    result?: Record<string, unknown>,
  ): Promise<void>;
  /** PostgreSQL revision CAS and application DDL must share this locked transaction. */
  transaction?<T>(
    work: (store: AppModelHistoryStore, db: DatabaseInterface) => Promise<T>,
  ): Promise<T>;
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
      [
        createMigrationDefinition(
          'smrt_app_model_changes_v1',
          [
            `CREATE TABLE IF NOT EXISTS _smrt_app_model_changes (
      application TEXT NOT NULL, tenant_id ${engine === 'postgres' ? 'UUID' : 'TEXT'} NOT NULL, revision ${engine === 'postgres' ? 'BIGINT' : 'INTEGER'} NOT NULL,
      request_id TEXT NOT NULL, actor TEXT NOT NULL, command TEXT NOT NULL,
      before_doc TEXT NOT NULL, after_doc TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied')),
      undoes ${engine === 'postgres' ? 'BIGINT' : 'INTEGER'}, elapsed_ms ${engine === 'postgres' ? 'BIGINT' : 'INTEGER'},
      PRIMARY KEY (application, tenant_id, revision),
      UNIQUE (application, tenant_id, request_id)
    )`,
          ],
          [],
          { packageName: '@happyvertical/smrt-core', version: '1' },
        ),
        createMigrationDefinition(
          'smrt_app_model_changes_v2',
          [
            'ALTER TABLE _smrt_app_model_changes ADD COLUMN operation_json TEXT',
            'ALTER TABLE _smrt_app_model_changes ADD COLUMN receipt_json TEXT',
            'ALTER TABLE _smrt_app_model_changes ADD COLUMN result_json TEXT',
          ],
          [],
          { packageName: '@happyvertical/smrt-core', version: '2' },
        ),
      ],
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
  const bound = (db: DatabaseInterface): AppModelHistoryStore => ({
    supportsDurableOperations: true,
    async read() {
      const { rows } = await db.query(
        `SELECT * FROM _smrt_app_model_changes WHERE application = ? AND tenant_id = ? ORDER BY revision`,
        [application, tenantId],
      );
      return rows.map((row) => ({
        revision: toSafeInteger(row.revision, 'App model revision'),
        requestId: String(row.request_id),
        actor: String(row.actor),
        command: String(row.command),
        before: JSON.parse(String(row.before_doc)),
        after: JSON.parse(String(row.after_doc)),
        status: row.status as AppModelChange['status'],
        ...(row.operation_json
          ? { operation: JSON.parse(String(row.operation_json)) }
          : {}),
        ...(row.receipt_json
          ? { receipt: JSON.parse(String(row.receipt_json)) }
          : {}),
        ...(row.result_json
          ? { result: JSON.parse(String(row.result_json)) }
          : {}),
        ...(row.undoes != null
          ? { undoes: toSafeInteger(row.undoes, 'Undone revision') }
          : {}),
        ...(row.elapsed_ms != null
          ? {
              elapsedMs:
                engine === 'postgres'
                  ? toSafeInteger(
                      row.elapsed_ms,
                      'App model elapsed milliseconds',
                    )
                  : Number(row.elapsed_ms),
            }
          : {}),
      }));
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
        const latest = (await scoped.read()).at(-1);
        if (latest?.revision !== revision)
          throw new Error('MODEL_EDIT_CONFLICT: history advanced');
        if (latest.status === 'pending')
          await scoped.complete(revision, elapsedMs, receipt, result);
      });
  }
  return store;
}

/** Compatibility name retained for existing local hosts. */
export const createSqliteAppModelHistory = createAppModelHistory;
