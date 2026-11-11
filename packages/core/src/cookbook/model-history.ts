/** Host-owned app schema revision journal. SQLite default, provisioned by tracked migrations. */

import type { Cookbook } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { createMigrationDefinition } from '../migrations/generator.js';
import { MigrationTracker } from '../migrations/tracker.js';
import { getDatabaseEngine } from '../system/compatibility.js';

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
}
/** One application/tenant binding per store. append must atomically check the latest revision. */
export interface AppModelHistoryStore {
  read(): Promise<AppModelChange[]>;
  append(change: AppModelChange, expectedRevision: number): Promise<void>;
  complete(revision: number, elapsedMs: number): Promise<void>;
}

export async function createSqliteAppModelHistory(options: {
  db: DatabaseInterface;
  application: string;
  tenantId: string;
}): Promise<AppModelHistoryStore> {
  const { db, application, tenantId } = options;
  if (getDatabaseEngine(db) !== 'sqlite' || !application || !tenantId)
    throw new Error(
      'The default model history requires SQLite and explicit application/tenant identities',
    );
  const tracker = new MigrationTracker({ db, engineHint: 'sqlite' });
  const results = await tracker.applyAll(
    [
      createMigrationDefinition(
        'smrt_app_model_changes_v1',
        [
          `CREATE TABLE IF NOT EXISTS _smrt_app_model_changes (
      application TEXT NOT NULL, tenant_id TEXT NOT NULL, revision INTEGER NOT NULL,
      request_id TEXT NOT NULL, actor TEXT NOT NULL, command TEXT NOT NULL,
      before_doc TEXT NOT NULL, after_doc TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied')),
      undoes INTEGER, elapsed_ms INTEGER,
      PRIMARY KEY (application, tenant_id, revision),
      UNIQUE (application, tenant_id, request_id)
    )`,
        ],
        [],
        { packageName: '@happyvertical/smrt-core', version: '1' },
      ),
    ],
    { postgresSafe: false, reconcile: false },
  );
  if (results.some((r) => !r.success))
    throw new Error('Could not migrate the app model history');
  return {
    async read() {
      const { rows } = await db.query(
        `SELECT * FROM _smrt_app_model_changes WHERE application = ? AND tenant_id = ? ORDER BY revision`,
        [application, tenantId],
      );
      return rows.map((row) => ({
        revision: Number(row.revision),
        requestId: String(row.request_id),
        actor: String(row.actor),
        command: String(row.command),
        before: JSON.parse(String(row.before_doc)),
        after: JSON.parse(String(row.after_doc)),
        status: row.status as AppModelChange['status'],
        ...(row.undoes != null ? { undoes: Number(row.undoes) } : {}),
        ...(row.elapsed_ms != null
          ? { elapsedMs: Number(row.elapsed_ms) }
          : {}),
      }));
    },
    async append(change, expectedRevision) {
      // One insert statement is the CAS even across two SQLite connections.
      const { rows } = await db.query(
        `INSERT INTO _smrt_app_model_changes
        (application, tenant_id, revision, request_id, actor, command, before_doc, after_doc, status, undoes)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
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
    async complete(revision, elapsedMs) {
      const { rows } = await db.query(
        `UPDATE _smrt_app_model_changes SET status = 'applied', elapsed_ms = ? WHERE application = ? AND tenant_id = ? AND revision = ? RETURNING revision`,
        [elapsedMs, application, tenantId, revision],
      );
      if (rows.length !== 1)
        throw new Error('MODEL_EDIT_CONFLICT: missing pending revision');
    },
  };
}
