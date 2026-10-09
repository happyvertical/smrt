import type { CatalogModel } from '../catalog/types.ts';
import { PAID_PAYMENT_STATUS } from './derived.ts';
import {
  createRandom,
  DAY,
  EPOCH,
  fakeId,
  fakeRecord,
  hashString,
  type ModelRecord,
} from './fakes.ts';

const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** Invoices that can be paid: sent out, with something owing. */
const billable = (invoice: ModelRecord) =>
  invoice.status !== 'draft' &&
  invoice.status !== 'cancelled' &&
  num(invoice.totalAmount) > 0;

export interface AllocationSpec {
  /** The allocation model (a payment applied to an invoice). */
  model: CatalogModel;
  paymentFk: string;
  invoiceFk: string;
}

/**
 * Sample payment allocations that add up. Each allocation links one completed
 * payment to one invoice of the same customer, is no more than what the
 * invoice still owes or the payment can cover, and is dated the day the payment
 * was made, never before the invoice was issued. A payment that is pending,
 * failed, refunded or cancelled applies to nothing. Payments are adjusted in
 * place to match what they were applied to (amount, date, contract).
 */
export function fakeAllocations(
  spec: AllocationSpec,
  payments: ModelRecord[],
  invoices: readonly ModelRecord[],
  seed: number,
): ModelRecord[] {
  const owed = new Map(
    invoices.map((inv) => [inv.id, num(inv.totalAmount)] as const),
  );
  const rows: ModelRecord[] = [];
  for (const payment of payments) {
    if (payment.status !== PAID_PAYMENT_STATUS) {
      if (payment.status !== 'refunded') payment.paidAt = null;
      continue;
    }
    const random = createRandom(hashString(`${seed}:alloc:${payment.id}`));
    const open = invoices.filter(
      (inv) =>
        billable(inv) &&
        inv.customerId === payment.customerId &&
        (owed.get(inv.id) ?? 0) > 0,
    );
    const chosen = open.slice(0, random() < 0.3 ? 2 : 1);
    if (chosen.length === 0) continue;
    const parts = chosen.map((inv, i) => {
      const balance = owed.get(inv.id) ?? 0;
      // The first invoice is often paid in full, otherwise about half.
      const part =
        i > 0 || random() < 0.6
          ? balance
          : Math.min(
              balance,
              Math.max(
                100,
                Math.round((balance * (0.3 + random() * 0.4)) / 100) * 100,
              ),
            );
      owed.set(inv.id, balance - part);
      return { inv, part };
    });
    const issued = Math.max(
      ...parts.map(({ inv }) => Date.parse(String(inv.issueDate))),
    );
    const paidAt = new Date(
      Math.max(
        issued,
        Math.min(issued + (1 + Math.floor(random() * 20)) * DAY, EPOCH),
      ),
    ).toISOString();
    payment.amount = parts.reduce((sum, p) => sum + p.part, 0);
    payment.paidAt = paidAt;
    if ('contractId' in payment && parts[0]?.inv.contractId) {
      payment.contractId = parts[0].inv.contractId;
    }
    for (const { inv, part } of parts) {
      rows.push({
        ...fakeRecord(spec.model, rows.length, seed),
        id: fakeId(`${spec.model.id}:${payment.id}:${inv.id}`),
        [spec.paymentFk]: payment.id,
        [spec.invoiceFk]: inv.id,
        amount: part,
        allocatedAt: paidAt,
      });
    }
  }
  return rows;
}
