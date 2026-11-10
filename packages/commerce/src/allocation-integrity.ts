/** Transactional allocation invariants shared by the owning models. */
import { isPostgresDatabase } from '@happyvertical/smrt-core';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import type { Invoice } from './models/Invoice.js';
import type { Payment } from './models/Payment.js';

export function allocationOwner(value: string | null): string | null {
  return value || getTenantId() || null;
}

/** Claim the persisted parent before reading dependants, including at repeatable read. */
export async function claimAllocationParent(
  parent: Payment | Invoice,
  kind: 'payment' | 'invoice',
  expectedUpdatedAt?: Date | string,
): Promise<void> {
  if (!parent.id) return;
  const { PaymentCollection } = await import(
    './collections/PaymentCollection.js'
  );
  const { InvoiceCollection } = await import(
    './collections/InvoiceCollection.js'
  );
  const collection =
    kind === 'payment'
      ? await PaymentCollection.create({ db: parent.db })
      : await InvoiceCollection.create({ db: parent.db });
  const persisted = await collection.get({ id: parent.id }, { cache: false });
  if (!persisted) return;
  const expected = parent.isPersisted
    ? (expectedUpdatedAt ?? parent.updated_at)
    : persisted.updated_at;
  if (!expected) throw new Error('Allocation parent has no persisted revision');
  await persisted.claimRevision(expected);
  parent.updated_at = persisted.updated_at;
}

/** Exact totals must never silently exceed JavaScript's integer range. */
export function allocationTotal(
  rows: { amount: number; id?: string | null }[],
  excluding?: string | null,
): bigint {
  return rows.reduce((total, row) => {
    if (row.id === excluding) return total;
    if (!Number.isSafeInteger(row.amount) || row.amount <= 0) {
      throw new Error('Invalid persisted payment allocation amount');
    }
    return total + BigInt(row.amount);
  }, 0n);
}

/** Parent corrections cannot invalidate an already committed allocation. */
export async function assertAllocationParent(
  parent: Payment | Invoice,
  kind: 'payment' | 'invoice',
): Promise<void> {
  if (!parent.id) return;
  const { PaymentAllocationCollection } = await import(
    './collections/PaymentAllocationCollection.js'
  );
  const allocations = await PaymentAllocationCollection.create({
    db: parent.db,
  });
  // Payment-only deployments need not provision allocation storage. PostgreSQL's
  // information_schema hides inaccessible tables, so use its catalog lookup and
  // let the subsequent read report permission errors for an existing table.
  const exists = isPostgresDatabase(parent.db)
    ? (
        await parent.db.query('SELECT to_regclass(?) AS relation', [
          allocations.tableName,
        ])
      ).rows[0]?.relation != null
    : await parent.db.tableExists(allocations.tableName);
  if (!exists) return;
  const rows =
    kind === 'payment'
      ? await allocations.findByPayment(parent.id)
      : await allocations.findByInvoice(parent.id);
  if (!rows.length) return;
  const { PaymentCollection } = await import(
    './collections/PaymentCollection.js'
  );
  const { InvoiceCollection } = await import(
    './collections/InvoiceCollection.js'
  );
  const opposite =
    kind === 'payment'
      ? await InvoiceCollection.create({ db: parent.db })
      : await PaymentCollection.create({ db: parent.db });
  const cap =
    kind === 'payment'
      ? (parent as Payment).amount
      : (parent as Invoice).totalAmount -
        ((parent as Invoice).getPayableFacts().retainedMinor -
          (parent as Invoice).getPayableFacts().releasedMinor);
  if (allocationTotal(rows) > BigInt(cap))
    throw new Error('Parent amount cannot be less than committed allocations');
  for (const row of rows) {
    const other = await opposite.get(
      { id: kind === 'payment' ? row.invoiceId : row.paymentId },
      { cache: false },
    );
    if (
      !other ||
      row.tenantId !== allocationOwner(parent.tenantId) ||
      other.tenantId !== row.tenantId ||
      (other.customerId || null) !== (parent.customerId || null) ||
      other.currency !== parent.currency
    ) {
      throw new Error(
        'Parent correction would invalidate payment allocation tenant, customer or currency',
      );
    }
  }
}
