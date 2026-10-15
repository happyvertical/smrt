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

/** @internal Whether any Invoice or Contract row, header or line, exists for a tenant. */
export async function tenantHasMoneyDocuments(
  db: DatabaseInterface,
  tenantId: string,
): Promise<boolean> {
  for (const table of MONEY_DOCUMENT_TABLES) {
    if (db.tableExists && !(await db.tableExists(table))) continue;
    const result = await db.query(
      `SELECT 1 AS found FROM ${table} WHERE CAST(tenant_id AS TEXT) = ? LIMIT 1`,
      tenantId,
    );
    if (result.rows.length > 0) return true;
  }
  return false;
}

/** @internal The model a tenant's first marker row is created with. */
export async function initialTenantMoneyModel(
  db: DatabaseInterface,
  tenantId: string,
): Promise<'legacy' | 'v2'> {
  return (await tenantHasMoneyDocuments(db, tenantId)) ? 'legacy' : 'v2';
}
