/**
 * `_smrt_app_model_changes`: the host-owned journal of run-time app model
 * edits (`cookbook/model-history.ts`). A core `_smrt_*` system table, so its
 * statements live with the other system tables (#4930). The journal provisions
 * it lazily through the migration tracker, in these two tracked steps.
 */
import { createMigrationDefinition } from '../migrations/generator.js';
import type { MigrationDefinition } from '../schema/types.js';

export const APP_MODEL_CHANGES_TABLE = '_smrt_app_model_changes';

/** The tracked migrations that create and extend the journal table. */
export function appModelChangesMigrations(
  engine: 'sqlite' | 'postgres',
): MigrationDefinition[] {
  const id = engine === 'postgres' ? 'UUID' : 'TEXT';
  const integer = engine === 'postgres' ? 'BIGINT' : 'INTEGER';
  return [
    createMigrationDefinition(
      'smrt_app_model_changes_v1',
      [
        `CREATE TABLE IF NOT EXISTS ${APP_MODEL_CHANGES_TABLE} (
      application TEXT NOT NULL, tenant_id ${id} NOT NULL, revision ${integer} NOT NULL,
      request_id TEXT NOT NULL, actor TEXT NOT NULL, command TEXT NOT NULL,
      before_doc TEXT NOT NULL, after_doc TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied')),
      undoes ${integer}, elapsed_ms ${integer},
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
        `ALTER TABLE ${APP_MODEL_CHANGES_TABLE} ADD COLUMN operation_json TEXT`,
        `ALTER TABLE ${APP_MODEL_CHANGES_TABLE} ADD COLUMN receipt_json TEXT`,
        `ALTER TABLE ${APP_MODEL_CHANGES_TABLE} ADD COLUMN result_json TEXT`,
      ],
      [],
      { packageName: '@happyvertical/smrt-core', version: '2' },
    ),
  ];
}
