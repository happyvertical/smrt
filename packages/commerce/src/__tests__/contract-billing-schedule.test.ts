import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { allocateContractMilestones } from '../contract-billing-schedule.js';
import { proveContractSchedule } from './helpers/contract-schedule-suite.js';

describe('approved contract milestone billing (#4074)', () => {
  it('allocates exact rational weights and places remainder on final milestone', () => {
    expect(allocateContractMilestones(100, [1, 1, 1])).toEqual([33, 33, 34]);
    expect(allocateContractMilestones(1, [1, 1, 1])).toEqual([0, 0, 1]);
    expect(allocateContractMilestones(0, [1])).toEqual([0]);
    const large = allocateContractMilestones(Number.MAX_SAFE_INTEGER, [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ]);
    expect(large.reduce((sum, amount) => sum + BigInt(amount), 0n)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
    for (const amount of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
      expect(() => allocateContractMilestones(amount, [1])).toThrow();
    for (const weights of [[], [0], [-1], [0.1], [Number.POSITIVE_INFINITY]])
      expect(() => allocateContractMilestones(100, weights)).toThrow();
  });
  it('preserves approval, issued history, exact money, tenant and transaction boundaries on SQLite', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    try {
      await proveContractSchedule(db);
    } finally {
      disableTenancy();
      await db.close?.();
    }
  });
});
