/** Shared historical/live invoice capacity. This module is private to the owning package. */
import { isPostgresDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { HistoricalCustomerFundsAllocationCollection } from './collections/HistoricalCustomerFundsCollections.js';

async function exists(db: DatabaseInterface) {
  return isPostgresDatabase(db)
    ? (
        await db.query('SELECT to_regclass(?) AS relation', [
          'historical_customer_funds_allocations',
        ])
      ).rows[0]?.relation != null
    : db.tableExists('historical_customer_funds_allocations');
}
export async function historicalInvoiceAllocationTotal(
  db: DatabaseInterface,
  invoiceId: string,
  effect?: 'payment' | 'refund',
): Promise<number> {
  if (effect === 'refund')
    return historicalCreditRefundCommittedTotal(db, invoiceId);
  if (!(await exists(db)))
    return historicalCreditRefundCommittedTotal(db, invoiceId);
  const tenantId = getTenantId();
  if (!tenantId) {
    if (
      (
        await db.query(
          'SELECT id FROM historical_customer_funds_allocations WHERE invoice_id=? LIMIT 1',
          invoiceId,
        )
      ).rows.length
    )
      throw new Error(
        'Historical allocation capacity requires the explicit active tenant',
      );
    return historicalCreditRefundCommittedTotal(db, invoiceId);
  }
  const rows = await (
    await HistoricalCustomerFundsAllocationCollection.create({ db })
  ).list({
    where: { tenantId, invoiceId, effect: 'payment' },
    limit: 100001,
  });
  if (rows.length > 100000)
    throw new Error(
      'Historical allocation capacity exceeds the bounded source scope',
    );
  const total = rows
    .filter((row) => row.effect === 'payment')
    .reduce((sum, row) => sum + BigInt(row.amountMinor), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Historical allocation capacity is unsafe');
  const combined =
    total +
    BigInt(
      effect === 'payment'
        ? 0
        : await historicalCreditRefundCommittedTotal(db, invoiceId),
    );
  if (combined > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Historical combined capacity is unsafe');
  return Number(combined);
}

/** Original cash refunds reserve capacity before their separately preserved allocation arrives. */
export async function historicalCreditRefundCommittedTotal(
  db: DatabaseInterface,
  creditNoteId: string,
): Promise<number> {
  const available = isPostgresDatabase(db)
    ? (
        await db.query('SELECT to_regclass(?) AS relation', [
          'historical_customer_funds',
        ])
      ).rows[0]?.relation != null
    : await db.tableExists('historical_customer_funds');
  if (!available) return 0;
  const tenantId = getTenantId();
  if (!tenantId) {
    if (
      (
        await db.query(
          'SELECT id FROM historical_customer_funds WHERE source_credit_note_id=? LIMIT 1',
          creditNoteId,
        )
      ).rows.length
    )
      throw new Error(
        'Historical refund capacity requires the explicit active tenant',
      );
    return 0;
  }
  const { HistoricalCustomerFundsCollection } = await import(
    './collections/HistoricalCustomerFundsCollections.js'
  );
  const rows = await (
    await HistoricalCustomerFundsCollection.create({ db })
  ).list({
    where: { tenantId, sourceCreditNoteId: creditNoteId, kind: 'refund' },
    limit: 100001,
  });
  if (rows.length > 100000)
    throw new Error(
      'Historical credit refund source scope exceeds its bounded limit',
    );
  const total = rows.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Historical refund source total is unsafe');
  return Number(total);
}
