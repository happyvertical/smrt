import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';

class LegacySystemTableProbe extends SmrtObject {
  value: string = '';
}

describe('system table compatibility', () => {
  it('upgrades legacy dispatch tables before replaying system DDL', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    await db.query(`
      CREATE TABLE _smrt_dispatch (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        processed_at TIMESTAMP,
        processed_by TEXT,
        metadata TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const probe = new LegacySystemTableProbe({ db, value: 'probe' });
    await probe.initialize();

    const columns = await db.query(`PRAGMA table_info(_smrt_dispatch)`);
    const columnNames = columns.rows.map((row: { name: string }) => row.name);
    expect(columnNames).toContain('target_subscriber');
    expect(columnNames).toContain('correlation_id');

    const indexes = await db.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name IN ('idx_smrt_dispatch_target', 'idx_smrt_dispatch_correlation')
    `);
    const indexNames = indexes.rows.map((row: { name: string }) => row.name);
    expect(indexNames).toContain('idx_smrt_dispatch_target');
    expect(indexNames).toContain('idx_smrt_dispatch_correlation');
  });
});
