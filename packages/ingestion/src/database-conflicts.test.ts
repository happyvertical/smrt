import { describe, expect, it, vi } from 'vitest';
import {
  isDatabaseFailure,
  isTransactionConflict,
  retryTransactionConflicts,
} from './database-conflicts.js';

const coded = (code: string, message = 'driver error') =>
  Object.assign(new Error(message), { code });

describe('database conflicts (#4651)', () => {
  it('recognizes deadlocks and serialization failures through the cause chain', () => {
    expect(isTransactionConflict(coded('40P01'))).toBe(true);
    expect(isTransactionConflict(coded('40001'))).toBe(true);
    expect(
      isTransactionConflict(new Error('wrapped', { cause: coded('40P01') })),
    ).toBe(true);
    expect(isTransactionConflict(new Error('deadlock detected'))).toBe(true);
    expect(isTransactionConflict(coded('23505'))).toBe(false);
    expect(isTransactionConflict(new Error('Feedback unavailable'))).toBe(
      false,
    );
  });
  it('tells driver failures apart from refusals', () => {
    expect(isDatabaseFailure(coded('22P02'))).toBe(true);
    expect(isDatabaseFailure(coded('SQLITE_BUSY'))).toBe(true);
    expect(
      isDatabaseFailure(
        new Error('current transaction is aborted, commands ignored'),
      ),
    ).toBe(true);
    expect(isDatabaseFailure(new Error('Feedback binding changed'))).toBe(
      false,
    );
    expect(isDatabaseFailure(coded('ERR_HOST'))).toBe(false);
  });
  it('re-runs only conflicts, a bounded number of times', async () => {
    const flaky = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(coded('40P01'))
      .mockRejectedValueOnce(coded('40001'))
      .mockResolvedValue('read');
    await expect(retryTransactionConflicts(flaky)).resolves.toBe('read');
    expect(flaky).toHaveBeenCalledTimes(3);

    const refused = vi.fn(async () => {
      throw new Error('Feedback unavailable');
    });
    await expect(retryTransactionConflicts(refused)).rejects.toThrow(
      'Feedback unavailable',
    );
    expect(refused).toHaveBeenCalledTimes(1);

    const stuck = vi.fn(async () => {
      throw coded('40P01');
    });
    await expect(retryTransactionConflicts(stuck, 3)).rejects.toMatchObject({
      code: '40P01',
    });
    expect(stuck).toHaveBeenCalledTimes(3);
  });
});
