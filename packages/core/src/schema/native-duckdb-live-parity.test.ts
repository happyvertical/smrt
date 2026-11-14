import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it, vi } from 'vitest';
import { checkLiveSchemaParity } from './live-parity.js';

it('#4972 round3 item4: identifies real native DuckDB before its exportTable method can look like JSON', async () => {
  const { getDatabase } =
    await vi.importActual<typeof import('@happyvertical/sql')>(
      '@happyvertical/sql',
    );
  const db: DatabaseInterface = await getDatabase({
    type: 'duckdb',
    url: ':memory:',
  });
  try {
    await db.query('CREATE TABLE native_parity (qty INTEGER)');
    const report = await checkLiveSchemaParity({
      db,
      engineHint: 'duckdb',
      includeSystemTables: false,
      schemas: {
        native_parity: {
          tableName: 'native_parity',
          columns: { qty: { type: 'INTEGER' } },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1',
        },
      },
    });
    expect(report.engine).toBe('duckdb');
  } finally {
    await db.close?.();
  }
});
