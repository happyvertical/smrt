/**
 * Dispatch bus lease option validation (P6 T36): an invalid value throws
 * naming the option, before any database is opened.
 */

import { describe, expect, it } from 'vitest';
import { createDispatchBus, DispatchBus } from './bus.js';

const db = { type: 'sqlite' as const, url: ':memory:' };

describe('dispatch bus lease options', () => {
  it.each([
    ['leaseMs', 999],
    ['leaseMs', 1500.5],
    ['leaseMs', Number.NaN],
    ['maxAttempts', 0],
    ['maxAttempts', 2.5],
    ['maxAttempts', -1],
  ])('rejects %s = %s naming the option', async (option, value) => {
    await expect(createDispatchBus({ db, [option]: value })).rejects.toThrow(
      new RegExp(`\\b${option}\\b`),
    );
    expect(() => new DispatchBus({} as never, { [option]: value })).toThrow(
      new RegExp(`\\b${option}\\b`),
    );
  });

  it('accepts the documented minimums', () => {
    expect(
      () => new DispatchBus({} as never, { leaseMs: 1000, maxAttempts: 1 }),
    ).not.toThrow();
  });
});
