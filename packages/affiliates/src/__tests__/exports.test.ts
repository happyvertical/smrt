import {
  Commission as SalesCommission,
  CommissionCollection as SalesCommissionCollection,
  CommissionPayout,
  CommissionPayoutCollection,
  Earner,
  EarnerCollection,
} from '@happyvertical/smrt-sales';
import { describe, expect, it } from 'vitest';
import {
  Commission,
  CommissionCollection,
  CommissionStatus,
  CommissionType,
  Partner,
  PartnerCollection,
  PartnerStatus,
  PartnerType,
  Payout,
  PayoutCollection,
  PayoutMethod,
  PayoutStatus,
} from '../index.js';

describe('@happyvertical/smrt-affiliates deprecated compatibility shim', () => {
  it('re-exports the smrt-sales classes under the legacy names (same references)', () => {
    expect(Partner).toBeDefined();
    expect(PartnerCollection).toBeDefined();
    expect(Commission).toBeDefined();
    expect(CommissionCollection).toBeDefined();
    expect(Payout).toBeDefined();
    expect(PayoutCollection).toBeDefined();

    // Identity, not copies — the shim owns no classes of its own.
    expect(Partner).toBe(Earner);
    expect(PartnerCollection).toBe(EarnerCollection);
    expect(Commission).toBe(SalesCommission);
    expect(CommissionCollection).toBe(SalesCommissionCollection);
    expect(Payout).toBe(CommissionPayout);
    expect(PayoutCollection).toBe(CommissionPayoutCollection);
  });

  it('preserves the exact legacy enum members and string values', () => {
    expect(PartnerStatus).toEqual({
      PENDING: 'pending',
      ACTIVE: 'active',
      SUSPENDED: 'suspended',
    });
    expect(PartnerType).toEqual({
      PUBLISHER: 'publisher',
      SALESPERSON: 'salesperson',
      REFERRER: 'referrer',
    });
    expect(CommissionType).toEqual({
      DISPLAY: 'display',
      REFERRAL: 'referral',
      SALES: 'sales',
      PARENT: 'parent',
      OVERHEAD: 'overhead',
    });
    expect(CommissionStatus).toEqual({
      PENDING: 'pending',
      INCLUDED: 'included',
      PAID: 'paid',
    });
    expect(PayoutStatus).toEqual({
      PENDING: 'pending',
      APPROVED: 'approved',
      PROCESSING: 'processing',
      COMPLETED: 'completed',
      FAILED: 'failed',
    });
    expect(PayoutMethod).toEqual({
      BANK_TRANSFER: 'bank_transfer',
      CHECK: 'check',
      PAYPAL: 'paypal',
      CREDIT: 'credit',
    });
  });

  it('freezes the legacy const objects', () => {
    for (const legacyEnum of [
      PartnerStatus,
      PartnerType,
      CommissionType,
      CommissionStatus,
      PayoutStatus,
      PayoutMethod,
    ]) {
      expect(Object.isFrozen(legacyEnum)).toBe(true);
    }
  });

  it('keeps aligned legacy values compatible with the new unions', () => {
    // Values that have a direct new-world equivalent must stay equal so
    // migrated and unmigrated code interoperate on the same rows.
    expect(PartnerStatus.ACTIVE).toBe('active');
    expect(CommissionStatus.PENDING).toBe('pending');
    expect(CommissionStatus.PAID).toBe('paid');
    expect(PayoutStatus.COMPLETED).toBe('completed');
    expect(PayoutMethod.BANK_TRANSFER).toBe('bank_transfer');
  });

  it('constructs a Partner (an Earner) through the legacy name', () => {
    const partner = new Partner({
      displayName: 'x',
      status: PartnerStatus.ACTIVE,
      payoutMethod: PayoutMethod.PAYPAL,
    });

    expect(partner).toBeInstanceOf(Partner);
    expect(partner).toBeInstanceOf(Earner);
    expect(partner.displayName).toBe('x');
    expect(partner.status).toBe('active');
    expect(partner.payoutMethod).toBe('paypal');
    expect(partner.isActive()).toBe(true);
  });
});
