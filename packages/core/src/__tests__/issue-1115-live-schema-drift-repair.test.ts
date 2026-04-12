/**
 * Issue #1115: live schema drift must be repairable even when a previous
 * synthetic migration record already says "completed".
 *
 * This reproduces the shared-table failure mode from production:
 * - a live table exists but is missing a newer STI/shared column
 * - _smrt_schema_migrations already contains the synthetic add_column record
 * - the repair flow must still execute because the live schema is authoritative
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeChecksum } from '../migrations/checksum.js';
import { SchemaComparer } from '../migrations/differ.js';
import { MigrationTracker } from '../migrations/tracker.js';

describe('Issue #1115: live schema drift repair', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;
  let tracker: MigrationTracker;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    tracker = new MigrationTracker({ db });
    await tracker.initialize();
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('repairs a missing shared-table column even when the migration record already exists', async () => {
    await db.query('CREATE TABLE contents (id TEXT PRIMARY KEY)');

    const manifest = {
      contents: {
        tableName: 'contents',
        ddl: 'CREATE TABLE contents (id TEXT PRIMARY KEY, script_text TEXT);',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          script_text: { type: 'TEXT' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const comparer = new SchemaComparer(db as any);
    const diff = await comparer.compare(manifest as any);
    const addColumnChange = diff.changes.find(
      (change) =>
        change.type === 'add_column' &&
        change.table === 'contents' &&
        change.name === 'script_text',
    );

    expect(addColumnChange?.sql).toBeDefined();

    const migration = {
      id: 'add_column_contents_script_text',
      description: 'Add column script_text to contents',
      version: '1.0.0',
      up: [addColumnChange?.sql ?? ''],
      down: [],
    };

    await db.query(
      `INSERT INTO _smrt_schema_migrations
       (id, name, version, checksum, applied_checksum, status, attempts, is_reversible, batch)
       VALUES (?, ?, ?, ?, ?, 'completed', 1, 0, 1)`,
      randomUUID(),
      migration.id,
      migration.version,
      computeChecksum(migration.up),
      computeChecksum(migration.up),
    );

    const result = await tracker.apply(migration, { reconcile: true });

    expect(result.success).toBe(true);
    expect(result.applied).toBe(true);

    const schema = await db.getTableSchema?.('contents');
    expect(schema?.columns.script_text).toBeDefined();
  });
});
