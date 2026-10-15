/**
 * Initial tenant money model selection (#4009).
 *
 * A tenant's first `TaxSettings` row decides its money model once. A tenant
 * with no stored Invoice or Contract rows starts on `v2`; a tenant whose
 * documents predate the row keeps `legacy` and reaches `v2` only through the
 * explicit tenant migration. Neither helper reads through a collection: the
 * document collections would re-enter the tenant money barrier being built.
 */

import { isPostgresDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';

/** Header and line tables whose rows carry tenant money. */
const MONEY_DOCUMENT_TABLES = [
  'invoices',
  'invoice_line_items',
  'contracts',
  'contract_line_items',
] as const;

/**
 * @internal Serialize first-marker decisions for one tenant on PostgreSQL.
 *
 * The lock is transaction-scoped, so the caller must hold a transaction until
 * the marker row commits. Embedded engines are already single-writer through
 * the core embedded write queue that every model transaction enters.
 */
export async function lockTenantMoneyBootstrap(
  db: DatabaseInterface,
  tenantId: string,
): Promise<void> {
  if (!isPostgresDatabase(db)) return;
  await db.query(
    'SELECT pg_advisory_xact_lock(hashtext(CAST(? AS TEXT)))',
    `smrt-commerce-money:${tenantId}`,
  );
}

/**
 * @internal Whether any Invoice or Contract row, header or line, exists for a
 * tenant.
 *
 * The answer must not depend on who is asking. Under the PostgreSQL
 * permission policies a request transaction sees only the tables its
 * principal may read, so a caller without invoice access would see no
 * invoices and start a tenant that has them on v2. On PostgreSQL the scan
 * therefore runs in system context for its own statements only: the
 * transaction-local `smrt.system_context` setting is raised for the scan and
 * restored afterwards. The scan filters by the explicit tenant and returns a
 * boolean, never row data.
 */
export async function tenantHasMoneyDocuments(
  db: DatabaseInterface,
  tenantId: string,
): Promise<boolean> {
  const scan = async (): Promise<boolean> => {
    for (const table of MONEY_DOCUMENT_TABLES) {
      if (db.tableExists && !(await db.tableExists(table))) continue;
      const result = await db.query(
        `SELECT 1 AS found FROM ${table} WHERE CAST(tenant_id AS TEXT) = ? LIMIT 1`,
        tenantId,
      );
      if (result.rows.length > 0) return true;
    }
    return false;
  };
  if (!isPostgresDatabase(db)) return scan();
  const prior = String(
    (
      await db.query(
        "SELECT COALESCE(current_setting('smrt.system_context', true), '') AS value",
      )
    ).rows[0]?.value ?? '',
  );
  await db.query("SELECT set_config('smrt.system_context', 'true', true)");
  try {
    return await scan();
  } finally {
    await db.query("SELECT set_config('smrt.system_context', ?, true)", prior);
  }
}

/** @internal The model a tenant's first marker row is created with. */
export async function initialTenantMoneyModel(
  db: DatabaseInterface,
  tenantId: string,
): Promise<'legacy' | 'v2'> {
  return (await tenantHasMoneyDocuments(db, tenantId)) ? 'legacy' : 'v2';
}
