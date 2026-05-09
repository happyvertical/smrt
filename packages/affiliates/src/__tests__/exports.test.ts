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

describe('@happyvertical/smrt-affiliates exports', () => {
  it('exports model classes', () => {
    expect(typeof Partner).toBe('function');
    expect(typeof Commission).toBe('function');
    expect(typeof Payout).toBe('function');
  });

  it('exports collection classes', () => {
    expect(typeof PartnerCollection).toBe('function');
    expect(typeof CommissionCollection).toBe('function');
    expect(typeof PayoutCollection).toBe('function');
  });

  it('exports status and type enums with documented values', () => {
    expect(typeof PartnerStatus).toBe('object');
    expect(typeof PartnerType).toBe('object');
    expect(typeof CommissionStatus).toBe('object');
    expect(typeof CommissionType).toBe('object');
    expect(typeof PayoutStatus).toBe('object');
    expect(typeof PayoutMethod).toBe('object');
  });
});
