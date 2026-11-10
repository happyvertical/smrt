import { deterministicId } from './billing/units.js';
import { MoneyValidationError } from './money.js';

/** Host-authorized acceptance of a specific frozen local invoice snapshot. */
export interface QuickBooksPilotAcceptance {
  readonly obligationId: string;
  readonly quoteVersionId: string;
  readonly moneySnapshotId: string;
}

export interface QuickBooksPilotScope {
  readonly tenantId: string;
  readonly realmId: string;
  readonly environment: 'sandbox';
}

export interface QuickBooksPilotInvoiceEvidence extends QuickBooksPilotScope {
  readonly externalId: string;
  readonly customerExternalId: string;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  /** Provider calendar date, YYYY-MM-DD. */
  readonly dueDate: string | null;
  readonly balanceMinor: number;
  readonly voided: boolean;
  /** True only after the adapter has read all relevant linked transaction facts. */
  readonly complete: true;
  readonly transactions: readonly QuickBooksPilotTransaction[];
}

export interface QuickBooksPilotTransaction {
  readonly id: string;
  readonly kind: 'payment' | 'credit' | 'refund';
  /** Exact amount attributable to this invoice, not the entire transaction. */
  readonly amountMinor: number;
}

export interface QuickBooksPilotProjection {
  readonly balanceMinor: number;
  readonly paidMinor: number;
  readonly creditedMinor: number;
  readonly refundedMinor: number;
  readonly state:
    | 'unpaid'
    | 'partial'
    | 'paid'
    | 'credited'
    | 'refunded'
    | 'voided';
  readonly transactions: readonly QuickBooksPilotTransaction[];
  readonly observedAt: string;
}

export function pilotDisagreement(message: string): never {
  throw new MoneyValidationError(
    'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
    message,
  );
}

/** Use this ID when preparing the one canonical local invoice for the obligation. */
export function quickBooksPilotInvoiceId(
  tenantId: string,
  obligationId: string,
): Promise<string> {
  return deterministicId(['quickbooks-pilot-invoice', tenantId, obligationId]);
}

export function projectQuickBooksPilotEvidence(
  evidence: QuickBooksPilotInvoiceEvidence,
): QuickBooksPilotProjection {
  const { balanceMinor, totalMinor, voided, transactions } = evidence;
  if (
    evidence.complete !== true ||
    typeof voided !== 'boolean' ||
    !Number.isSafeInteger(balanceMinor) ||
    balanceMinor < 0 ||
    balanceMinor > totalMinor ||
    !Array.isArray(transactions)
  )
    pilotDisagreement('QuickBooks invoice readback is incomplete or invalid');

  const seen = new Set<string>();
  const facts: QuickBooksPilotTransaction[] = [];
  const sums = { payment: 0, credit: 0, refund: 0 };
  for (const entry of evidence.transactions) {
    if (!entry || typeof entry !== 'object')
      pilotDisagreement('QuickBooks linked transaction evidence is invalid');
    const { id, kind, amountMinor } = entry;
    if (
      !['payment', 'credit', 'refund'].includes(kind) ||
      typeof id !== 'string' ||
      !id ||
      id.trim() !== id ||
      !Number.isSafeInteger(amountMinor) ||
      amountMinor <= 0 ||
      seen.has(JSON.stringify([kind, id]))
    )
      pilotDisagreement(
        'QuickBooks linked transaction evidence is invalid or duplicated',
      );
    seen.add(JSON.stringify([kind, id]));
    facts.push({ id, kind, amountMinor });
    sums[kind] += amountMinor;
    if (!Number.isSafeInteger(sums[kind]))
      pilotDisagreement(
        'QuickBooks linked transaction totals exceed safe minor units',
      );
  }

  const paidMinor = sums.payment - sums.refund;
  if (
    paidMinor < 0 ||
    (voided
      ? balanceMinor !== 0 || paidMinor !== 0 || sums.credit !== 0
      : BigInt(paidMinor) + BigInt(sums.credit) + BigInt(balanceMinor) !==
        BigInt(totalMinor))
  )
    pilotDisagreement(
      'QuickBooks balance disagrees with linked transaction evidence',
    );

  let state: QuickBooksPilotProjection['state'] = 'unpaid';
  if (voided) state = 'voided';
  else if (sums.refund > 0) state = 'refunded';
  else if (balanceMinor === 0 && sums.credit > 0) state = 'credited';
  else if (balanceMinor === 0) state = 'paid';
  else if (paidMinor > 0 || sums.credit > 0) state = 'partial';

  return {
    balanceMinor,
    paidMinor,
    creditedMinor: sums.credit,
    refundedMinor: sums.refund,
    state,
    transactions: facts,
    observedAt: new Date().toISOString(),
  };
}
