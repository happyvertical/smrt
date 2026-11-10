import { describe, expect, it } from 'vitest';
import {
  calculateInvoicePayable,
  type InvoiceRetentionState,
} from '../retention-money.js';

const state: InvoiceRetentionState = {
  version: 1,
  currency: 'CAD',
  creditPolicy: 'retained-first',
  retainedMinor: 1000,
  requestId: 'configure',
  policyVersion: 'tenant-v1',
  evidenceRef: 'approval-1',
  actorId: 'reviewer',
  reason: 'Approved retention',
  recordedAt: '2026-10-16T00:00:00Z',
  releases: [],
};
function facts(credit = 0, paid = 0, releases = state.releases) {
  return calculateInvoicePayable({
    totalAmount: 10500,
    creditedAmount: credit,
    amountPaid: paid,
    currency: 'CAD',
    retentionStateJson: JSON.stringify({ ...state, releases }),
  });
}
describe('explicit retained-first payable facts', () => {
  it('keeps gross balance separate from current due and releases', () => {
    expect(facts(0, 9500)).toMatchObject({
      grossBalanceMinor: 1000,
      currentlyDueMinor: 0,
      retainedRemainingMinor: 1000,
    });
    expect(
      facts(0, 9500, [{ ...state, requestId: 'release', amountMinor: 400 }]),
    ).toMatchObject({ currentlyDueMinor: 400, retainedRemainingMinor: 600 });
  });
  it('credits consume retention first; void restores it without modifying original evidence', () => {
    expect(facts(500)).toMatchObject({
      allocationCapMinor: 9500,
      retainedRemainingMinor: 500,
    });
    expect(facts(1500)).toMatchObject({
      allocationCapMinor: 9000,
      retainedRemainingMinor: 0,
    });
    expect(facts(0)).toMatchObject({
      allocationCapMinor: 9500,
      retainedRemainingMinor: 1000,
    });
  });
  it.each([
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid exact inputs %s', (amount) => {
    expect(() =>
      calculateInvoicePayable({
        totalAmount: amount,
        creditedAmount: 0,
        amountPaid: 0,
        currency: 'CAD',
      }),
    ).toThrow();
  });
  it('rejects malformed, unsupported, wrong-currency and overreleased evidence', () => {
    for (const patch of [
      { creditPolicy: 'invented' },
      { currency: 'USD' },
      { retainedMinor: 11000 },
      { releases: [{ ...state, requestId: 'release', amountMinor: 1001 }] },
    ]) {
      expect(() =>
        calculateInvoicePayable({
          totalAmount: 10500,
          creditedAmount: 0,
          amountPaid: 0,
          currency: 'CAD',
          retentionStateJson: JSON.stringify({ ...state, ...patch }),
        }),
      ).toThrow();
    }
  });
});
