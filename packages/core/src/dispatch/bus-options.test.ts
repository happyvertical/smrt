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
    ['legacyLeaseGraceMs', 0],
    ['legacyLeaseGraceMs', -5],
    ['legacyLeaseGraceMs', 1.5],
  ])('rejects %s = %s naming the option', async (option, value) => {
    await expect(createDispatchBus({ db, [option]: value })).rejects.toThrow(
      new RegExp(`\\b${option}\\b`),
    );
    expect(() => new DispatchBus({} as never, { [option]: value })).toThrow(
      new RegExp(`\\b${option}\\b`),
    );
  });

  it.each([
    [{ maxExecutionMs: 999 }],
    [{ leaseMs: 5000, maxExecutionMs: 4999 }],
    [{ maxExecutionMs: 1500.5 }],
  ])('rejects maxExecutionMs below leaseMs or not an integer (%o)', async (options) => {
    await expect(createDispatchBus({ db, ...options })).rejects.toThrow(
      /\bmaxExecutionMs\b/,
    );
    expect(() => new DispatchBus({} as never, options)).toThrow(
      /\bmaxExecutionMs\b/,
    );
  });

  it('rejects an invalid per-call maxExecutionMs naming the option', async () => {
    const bus = await createDispatchBus({ db, leaseMs: 1000 });
    await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
    await expect(
      bus.process('worker', async () => {}, { maxExecutionMs: 10 }),
    ).rejects.toThrow(/\bmaxExecutionMs\b/);
  });

  it('accepts the documented minimums', () => {
    expect(
      () => new DispatchBus({} as never, { leaseMs: 1000, maxAttempts: 1 }),
    ).not.toThrow();
  });
});
