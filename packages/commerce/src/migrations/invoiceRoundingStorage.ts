/** Explicit additive storage for opt-in invoice rounding; no historical money is rewritten. */
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';

/** Persisted rounding storage engines; complete Commerce models support SQLite/PostgreSQL. */
export type InvoiceRoundingStorageEngine = 'sqlite' | 'postgres' | 'duckdb';

/**
 * Add empty policy/allocation/frozen-snapshot storage in a writer maintenance
 * window. Existing invoices remain per-line; repeated migration is harmless.
 * Absent tables are skipped, never marked migrated. Runtime never invokes this.
 */
export async function migrateInvoiceRoundingStorage(
  db: DatabaseInterface,
  engine: InvoiceRoundingStorageEngine,
): Promise<{ addedColumns: string[] }> {
  if (!['sqlite', 'postgres', 'duckdb'].includes(engine))
    throw new Error('Unsupported invoice rounding storage engine');
  if (!db.transaction)
    throw new Error('Invoice rounding migration requires transactions');
  const addedColumns: string[] = [];
  await db.transaction(async (tx) => {
    for (const [table, columns] of [
      [
        'invoices',
        ['invoice_rounding_policy_json', 'invoice_rounding_frozen_json'],
      ],
      ['invoice_line_items', ['invoice_tax_allocation_json']],
    ] as const) {
      const found =
        engine === 'sqlite'
          ? await tx.query(`PRAGMA table_info("${table}")`)
          : await tx.query(
              'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
              [table],
            );
      if (!found.rows.length) continue;
      if (engine === 'postgres')
        await tx.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
      const names = new Set(found.rows.map((row) => String(row.name)));
      for (const column of columns) {
        if (names.has(column)) continue;
        await tx.query(
          `ALTER TABLE "${table}" ADD COLUMN "${column}" TEXT DEFAULT ''`,
        );
        addedColumns.push(`${table}.${column}`);
      }
    }
  });
  return { addedColumns };
}
