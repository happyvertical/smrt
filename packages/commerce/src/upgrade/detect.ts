/**
 * Old-format commerce money data detection (#4021).
 *
 * The runtime knows one money model. Data written by an earlier version is
 * refused here, never read or computed: this module only answers "does this
 * database or tenant still hold old-format money data?" and raises
 * {@link CommerceDataNeedsUpgradeError} with the upgrade command.
 *
 * Old-format data has one of two shapes:
 *
 * - **Pre-#4021 schema.** A database last migrated by a version with the
 *   per-tenant money switch still has its columns (`tax_settings.money_model`,
 *   `tax_settings.money_migration_id`, `*_line_items.legacy_amount`) or the
 *   `money_migration_documents` table. The upgrade converts every tenant and
 *   drops them, so their presence means the database has not been upgraded.
 * - **Pre-settings tenant.** A tenant with Invoice or Contract rows but no
 *   `tax_settings` row. Its documents predate tenant tax settings.
 *
 * Delete this module, the `upgrade/` directory and its call sites together
 * once no supported version can have written old-format data.
 */

import { isPostgresDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  isMoneyTransaction,
  rootMoneyDatabase,
  withDocumentMoneyTransaction,
} from '../document-money-internal.js';

/** The stable code on {@link CommerceDataNeedsUpgradeError}. */
export const COMMERCE_DATA_NEEDS_UPGRADE = 'COMMERCE_DATA_NEEDS_UPGRADE';

/** The CLI command that converts old-format data, optionally for one tenant. */
export function commerceMoneyUpgradeCommand(tenantId?: string): string {
  return tenantId
    ? `smrt db:upgrade-commerce-money --tenant-id ${tenantId}`
    : 'smrt db:upgrade-commerce-money';
}

/** Commerce found money data written by an earlier version. */
export class CommerceDataNeedsUpgradeError extends Error {
  readonly code = COMMERCE_DATA_NEEDS_UPGRADE;

  constructor(
    readonly detail: string,
    readonly tenantId?: string,
  ) {
    super(
      `${COMMERCE_DATA_NEEDS_UPGRADE}: ${detail} Run ${commerceMoneyUpgradeCommand(tenantId)} to upgrade it.`,
    );
    this.name = 'CommerceDataNeedsUpgradeError';
  }
}

/** Header and line tables whose rows carry tenant money. */
export const MONEY_DOCUMENT_TABLES = [
  'invoices',
  'invoice_line_items',
  'contracts',
  'contract_line_items',
] as const;

/** Columns only a pre-#4021 schema has. The upgrade drops each one. */
export const OLD_MONEY_COLUMNS = [
  ['tax_settings', 'money_model'],
  ['tax_settings', 'money_migration_id'],
  ['invoice_line_items', 'legacy_amount'],
  ['contract_line_items', 'legacy_amount'],
] as const;

/** Tables only a pre-#4021 schema has. The upgrade drops each one. */
export const OLD_MONEY_TABLES = ['money_migration_documents'] as const;

function rowsOf(result: { rows: unknown[] }): Array<Record<string, unknown>> {
  return result.rows as Array<Record<string, unknown>>;
}

async function tableExists(
  db: DatabaseInterface,
  table: string,
): Promise<boolean> {
  return !db.tableExists || (await db.tableExists(table));
}

/**
 * Every pre-#4021 column (`table.column`) and table still in the schema, in
 * one catalog query. Empty means the schema carries no old money storage.
 */
export async function findOldMoneySchema(
  db: DatabaseInterface,
): Promise<string[]> {
  const found: string[] = [];
  if (isPostgresDatabase(db)) {
    const result = await db.query(
      `SELECT table_name AS "table", column_name AS "column"
         FROM information_schema.columns
        WHERE table_schema = ANY (current_schemas(false))
          AND ((table_name = 'tax_settings'
                AND column_name IN ('money_model', 'money_migration_id'))
            OR (table_name IN ('invoice_line_items', 'contract_line_items')
                AND column_name = 'legacy_amount'))
       UNION ALL
       SELECT table_name AS "table", '' AS "column"
         FROM information_schema.tables
        WHERE table_schema = ANY (current_schemas(false))
          AND table_name = 'money_migration_documents'`,
    );
    for (const row of rowsOf(result))
      found.push(row.column ? `${row.table}.${row.column}` : String(row.table));
  } else {
    for (const [table, column] of OLD_MONEY_COLUMNS) {
      if (!(await tableExists(db, table))) continue;
      const result = await db.query(
        `SELECT name FROM pragma_table_info('${table}') WHERE name = ?`,
        column,
      );
      if (result.rows.length > 0) found.push(`${table}.${column}`);
    }
    for (const table of OLD_MONEY_TABLES) {
      const result = await db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        table,
      );
      if (result.rows.length > 0) found.push(table);
    }
  }
  return found.sort();
}

/**
 * Run a scan whose answer must not depend on the caller's table permissions.
 *
 * Under the PostgreSQL permission policies a principal sees only the rows it
 * may read, so a caller without invoice access would find no documents. On
 * PostgreSQL the scan raises the transaction-local `smrt.system_context` for
 * its own statements and restores the caller's value afterwards. Callers
 * return booleans or tenant ids from the scan, never row data.
 */
async function withPermissionIndependentScan<T>(
  db: DatabaseInterface,
  scan: (db: DatabaseInterface) => Promise<T>,
): Promise<T> {
  if (!isPostgresDatabase(db)) return scan(db);
  const run = async (tx: DatabaseInterface): Promise<T> => {
    const prior = String(
      (
        await tx.query(
          "SELECT COALESCE(current_setting('smrt.system_context', true), '') AS value",
        )
      ).rows[0]?.value ?? '',
    );
    await tx.query("SELECT set_config('smrt.system_context', 'true', true)");
    try {
      return await scan(tx);
    } finally {
      await tx.query(
        "SELECT set_config('smrt.system_context', ?, true)",
        prior,
      );
    }
  };
  // A transaction-local setting outlives one statement only inside a
  // transaction; open one when the caller has not.
  return isMoneyTransaction(db) || !db.transaction
    ? run(db)
    : withDocumentMoneyTransaction(db, run);
}

/** Whether any Invoice or Contract row, header or line, exists for a tenant. */
export async function tenantHasMoneyDocuments(
  db: DatabaseInterface,
  tenantId: string,
): Promise<boolean> {
  return withPermissionIndependentScan(db, async (scanDb) => {
    for (const table of MONEY_DOCUMENT_TABLES) {
      if (!(await tableExists(scanDb, table))) continue;
      const result = await scanDb.query(
        `SELECT 1 AS found FROM ${table} WHERE CAST(tenant_id AS TEXT) = ? LIMIT 1`,
        tenantId,
      );
      if (result.rows.length > 0) return true;
    }
    return false;
  });
}

/** Why one tenant needs the upgrade. */
export interface TenantMoneyUpgradeNeed {
  tenantId: string;
  /**
   * - `legacy-marker`: the pre-#4021 switch keeps the tenant's documents in
   *   the old tax-inclusive line format.
   * - `interrupted-migration`: a pre-#4021 tenant migration never finished.
   * - `missing-settings`: documents but no tenant tax settings.
   */
  reason: 'legacy-marker' | 'interrupted-migration' | 'missing-settings';
}

/** The full database view: old schema storage and every tenant to convert. */
export interface CommerceMoneyUpgradeStatus {
  oldSchema: string[];
  tenants: TenantMoneyUpgradeNeed[];
}

/**
 * Scan the whole database for old-format money data. For `smrt db:status`,
 * `smrt app doctor` and the upgrade command; the runtime uses the cached
 * per-tenant check {@link assertTenantMoneyCurrent} instead.
 */
export async function findCommerceMoneyUpgradeNeeds(
  db: DatabaseInterface,
): Promise<CommerceMoneyUpgradeStatus> {
  const oldSchema = await findOldMoneySchema(db);
  const tenants = await withPermissionIndependentScan(db, async (scanDb) => {
    const needs = new Map<string, TenantMoneyUpgradeNeed['reason']>();
    const hasSettings = await tableExists(scanDb, 'tax_settings');
    if (hasSettings && oldSchema.includes('tax_settings.money_model')) {
      const markers = await scanDb.query(
        `SELECT CAST(tenant_id AS TEXT) AS "tenantId", money_model AS "model"
           FROM tax_settings
          WHERE money_model <> 'v2'`,
      );
      for (const row of rowsOf(markers))
        needs.set(
          String(row.tenantId),
          row.model === 'migrating' ? 'interrupted-migration' : 'legacy-marker',
        );
    }
    for (const table of ['invoices', 'contracts'] as const) {
      if (!(await tableExists(scanDb, table))) continue;
      const orphans = await scanDb.query(
        hasSettings
          ? `SELECT DISTINCT CAST(d.tenant_id AS TEXT) AS "tenantId"
               FROM ${table} d
              WHERE d.tenant_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM tax_settings s
                   WHERE CAST(s.tenant_id AS TEXT) = CAST(d.tenant_id AS TEXT))`
          : `SELECT DISTINCT CAST(tenant_id AS TEXT) AS "tenantId"
               FROM ${table} WHERE tenant_id IS NOT NULL`,
      );
      for (const row of rowsOf(orphans)) {
        const tenantId = String(row.tenantId);
        if (!needs.has(tenantId)) needs.set(tenantId, 'missing-settings');
      }
    }
    return [...needs]
      .map(([tenantId, reason]) => ({ tenantId, reason }))
      .sort((left, right) =>
        left.tenantId < right.tenantId
          ? -1
          : left.tenantId > right.tenantId
            ? 1
            : 0,
      );
  });
  return { oldSchema, tenants };
}

/** Databases and tenants already proven current, keyed by root database. */
const currentSchemas = new WeakSet<object>();
const currentTenants = new WeakMap<object, Set<string>>();
/** Executors of an upgrade transaction, which converts old-format data. */
const upgradeExecutors = new WeakSet<object>();

/**
 * @internal Run the upgrade's own transaction past the old-format checks, so
 * it can recompute converted drafts through the runtime. Only the exact
 * executor `tx` is exempt, and only while `operation` runs.
 */
export async function withCommerceMoneyUpgradeExecutor<T>(
  tx: DatabaseInterface,
  operation: () => Promise<T>,
): Promise<T> {
  upgradeExecutors.add(tx as object);
  try {
    return await operation();
  } finally {
    upgradeExecutors.delete(tx as object);
  }
}

/**
 * Refuse a database whose schema still carries pre-#4021 money storage.
 * Only a passing result is cached, so a database upgraded while the process
 * runs is accepted on the next call.
 */
export async function assertCommerceMoneySchemaCurrent(
  db: DatabaseInterface,
): Promise<void> {
  if (upgradeExecutors.has(db as object)) return;
  const root = rootMoneyDatabase(db) as object;
  if (currentSchemas.has(root)) return;
  const old = await findOldMoneySchema(db);
  if (old.length > 0)
    throw new CommerceDataNeedsUpgradeError(
      `The database holds commerce money data from an earlier version (${old.join(', ')}).`,
    );
  currentSchemas.add(root);
}

/**
 * Refuse a tenant whose money data predates the current model: first the
 * database-wide schema check, then documents without tenant tax settings.
 * Each database and tenant is checked once per process once it passes.
 */
export async function assertTenantMoneyCurrent(
  db: DatabaseInterface,
  tenantId: string,
): Promise<void> {
  if (upgradeExecutors.has(db as object)) return;
  const root = rootMoneyDatabase(db) as object;
  if (currentTenants.get(root)?.has(tenantId)) return;
  await assertCommerceMoneySchemaCurrent(db);
  const stale = await withPermissionIndependentScan(db, async (scanDb) => {
    if (!(await tableExists(scanDb, 'tax_settings'))) return false;
    const settings = await scanDb.query(
      'SELECT 1 AS found FROM tax_settings WHERE CAST(tenant_id AS TEXT) = ? LIMIT 1',
      tenantId,
    );
    if (settings.rows.length > 0) return false;
    for (const table of MONEY_DOCUMENT_TABLES) {
      if (!(await tableExists(scanDb, table))) continue;
      const found = await scanDb.query(
        `SELECT 1 AS found FROM ${table} WHERE CAST(tenant_id AS TEXT) = ? LIMIT 1`,
        tenantId,
      );
      if (found.rows.length > 0) return true;
    }
    return false;
  });
  if (stale)
    throw new CommerceDataNeedsUpgradeError(
      `Tenant ${tenantId} has commerce documents but no tenant tax settings.`,
      tenantId,
    );
  const tenants = currentTenants.get(root) ?? new Set<string>();
  tenants.add(tenantId);
  currentTenants.set(root, tenants);
}
