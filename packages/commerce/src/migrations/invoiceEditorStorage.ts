/** Explicit invoice quantity widening and additive editor-state storage migration. */
import {
  type DatabaseInterface,
  planSqliteTableRebuilds,
  sqliteRebuildPlaceholderSql,
} from '@happyvertical/smrt-core/migrations';
import { calculateInvoiceMinorLine } from '../svelte/invoices/calculations.js';

/** Supported SQL engines; explicit selection avoids guessing from connection URLs. */
export type InvoiceEditorStorageEngine = 'sqlite' | 'postgres' | 'duckdb';
/** Read-only quantity migration findings. */
export interface InvoiceEditorStoragePreflight {
  /** Requested engine. */
  engine: InvoiceEditorStorageEngine;
  /** Existing column type, or null when absent. */
  declaredType: string | null;
  /** All existing quantities satisfy numeric persistence and precision constraints. */
  ok: boolean;
  /** Whether the dedicated TEXT editor-state column already exists. */
  editorStateColumnPresent: boolean;
  /** Rows examined. */
  inspectedRows: number;
  /** Invalid row identifiers; no data is modified while findings remain. */
  invalidRowIds: string[];
}
/** Completed quantity migration report. */
export interface InvoiceEditorStorageMigrationResult {
  /** Preflight used to guard this migration. */
  preflight: InvoiceEditorStoragePreflight;
  /** True if quantity was widened or the editor-state column was added. */
  changed: boolean;
}
type QueryExecutor = Pick<DatabaseInterface, 'query'>;

function exactQuantity(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  const text = String(raw);
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return false;
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0) + 6;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return false;
  const coefficient = BigInt(match[1] + (match[2] ?? ''));
  const divisor = exponent < 0 ? 10n ** BigInt(-exponent) : 1n;
  if (coefficient % divisor !== 0n) return false;
  const scaled =
    exponent < 0
      ? coefficient / divisor
      : coefficient * 10n ** BigInt(exponent);
  const value = Number(text);
  try {
    calculateInvoiceMinorLine({
      quantity: value,
      unitPrice: 0,
      discount: 0,
      taxRate: 0,
    });
    return BigInt(value.toFixed(6).replace('.', '')) === scaled;
  } catch {
    return false;
  }
}

/** Inspect every existing quantity without rounding, rescaling, or modifying it. */
export async function preflightInvoiceEditorStorage(
  db: QueryExecutor,
  engine: InvoiceEditorStorageEngine,
): Promise<InvoiceEditorStoragePreflight> {
  if (!['sqlite', 'postgres', 'duckdb'].includes(engine))
    throw new Error('Unsupported invoice quantity engine.');
  const columns =
    engine === 'sqlite'
      ? await db.query('PRAGMA table_info("invoice_line_items")')
      : await db.query(
          "SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'invoice_line_items'",
        );
  const column = (columns.rows as { name: string; type: string }[]).find(
    (row) => row.name === 'quantity',
  );
  const result: InvoiceEditorStoragePreflight = {
    engine,
    declaredType: column?.type ?? null,
    ok: true,
    editorStateColumnPresent: (columns.rows as { name: string }[]).some(
      (row) => row.name === 'invoice_editor_state_json',
    ),
    inspectedRows: 0,
    invalidRowIds: [],
  };
  if (!column) {
    if (columns.rows.length)
      throw new Error('Invoice line table has no quantity column.');
    return result;
  }
  if (
    !/^(?:tinyint|smallint|integer|int|bigint|int[248]|hugeint|real|float|double(?: precision)?|decimal(?:\(.*\))?|numeric(?:\(.*\))?)$/i.test(
      column.type,
    )
  )
    throw new Error(`Unsupported invoice quantity column type: ${column.type}`);
  // Preserve exact integer/DECIMAL text, but read binary floats as numbers: SQLite's
  // CAST-to-text prints only 15 significant digits and can hide stored precision.
  const expression =
    engine === 'sqlite'
      ? "CASE WHEN typeof(quantity) = 'real' THEN quantity ELSE CAST(quantity AS VARCHAR) END"
      : /^(?:real|float|double(?: precision)?)$/i.test(column.type)
        ? 'quantity'
        : 'CAST(quantity AS VARCHAR)';
  const rows = await db.query(
    `SELECT id, ${expression} AS quantity FROM "invoice_line_items"`,
  );
  for (const row of rows.rows as { id: unknown; quantity: unknown }[]) {
    result.inspectedRows++;
    if (!exactQuantity(row.quantity)) result.invalidRowIds.push(String(row.id));
  }
  result.ok = result.invalidRowIds.length === 0;
  return result;
}

/**
 * Widen existing integer quantity columns without rescaling any values.
 * Run during a writer maintenance window using a root transaction-capable handle.
 * PostgreSQL locks writers while checking and altering; DuckDB detects conflicting transactions.
 * SQLite uses the core live-DDL rebuild planner and refuses unsafe incoming-FK rebuilds.
 * Repeating the migration is harmless and never marks an absent table as migrated.
 */
export async function migrateInvoiceEditorStorage(
  db: DatabaseInterface,
  engine: InvoiceEditorStorageEngine,
): Promise<InvoiceEditorStorageMigrationResult> {
  if (!db.transaction)
    throw new Error('Invoice quantity migration requires transaction support.');
  let result: InvoiceEditorStorageMigrationResult | undefined;
  await db.transaction(async (tx) => {
    // Acquire the PG lock only if the table exists, before reading quantities.
    if (engine === 'postgres') {
      const table = await tx.query(
        "SELECT to_regclass('invoice_line_items') AS name",
      );
      if (table.rows[0]?.name)
        await tx.query(
          'LOCK TABLE "invoice_line_items" IN ACCESS EXCLUSIVE MODE',
        );
    }
    const preflight = await preflightInvoiceEditorStorage(tx, engine);
    if (!preflight.ok)
      throw new RangeError(
        `Invoice quantity migration refused invalid rows: ${preflight.invalidRowIds.join(', ')}`,
      );
    const integer =
      preflight.declaredType !== null &&
      /^(?:tinyint|smallint|integer|int|bigint|int[248]|hugeint)$/i.test(
        preflight.declaredType,
      );
    result = { preflight, changed: false };
    if (integer && engine === 'sqlite') {
      const changes = await planSqliteTableRebuilds({
        db: tx as DatabaseInterface,
        tableName: 'invoice_line_items',
        changes: [
          {
            type: 'type_upgrade',
            table: 'invoice_line_items',
            name: 'quantity',
            column: { type: 'REAL' },
            sql: sqliteRebuildPlaceholderSql('quantity'),
          },
        ],
        mapType: () => 'REAL',
      });
      const statements = changes[0]?.sqlStatements;
      if (!statements?.length)
        throw new Error(
          `Invoice quantity rebuild requires explicit maintenance: ${changes[0]?.sql ?? 'no safe plan'}`,
        );
      for (const statement of statements) await tx.query(statement);
      result.changed = true;
    }
    if (integer && engine !== 'sqlite') {
      const type = engine === 'postgres' ? 'DOUBLE PRECISION' : 'DOUBLE';
      await tx.query(
        `ALTER TABLE "invoice_line_items" ALTER COLUMN "quantity" TYPE ${type} USING CAST("quantity" AS ${type})`,
      );
      result.changed = true;
    }
    if (
      preflight.declaredType !== null &&
      !preflight.editorStateColumnPresent
    ) {
      await tx.query(
        "ALTER TABLE invoice_line_items ADD COLUMN invoice_editor_state_json TEXT DEFAULT ''",
      );
      result.changed = true;
    }
  });
  if (!result)
    throw new Error('Invoice quantity migration transaction did not execute.');
  return result;
}
