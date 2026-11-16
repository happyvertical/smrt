import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  vi,
} from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import '../index.js';
import { defineAllocationSuite } from './helpers/allocation-suite.js';

/** Observe real construction without changing constructor identity or lifecycle.
 * Distinct service stack locations ensure every swept site is exercised. */
const expectedSites: Record<string, number> = {
  'expense-allocation.ts|ExpenseAllocationRevision': 2,
  'expense-allocation.ts|ExpenseAllocationPortion': 1,
  'expense-allocation.ts|ExpenseAllocationBilling': 3,
};

describe.each([false, true])('#4931 app replacement = %s', (replace) => {
  let app: Record<string, unknown> | undefined;
  let restoreRegistry: (() => void) | undefined;
  const seen = new Map<string, Set<string>>();
  let restoreSpy: (() => void) | undefined;
  beforeAll(async () => {
    restoreRegistry = snapshotObjectRegistryState();
    if (replace) app = await import('./issue-4931-app.fixture.js');
  });
  beforeEach(() => {
    const resolve =
      ObjectRegistry.resolveEffectiveConstructor.bind(ObjectRegistry);
    const spy = vi
      .spyOn(ObjectRegistry, 'resolveEffectiveConstructor')
      .mockImplementation((model) => {
        const effective = resolve(model);
        const stack = new Error().stack ?? '';
        const key = Object.keys(expectedSites).find((key) => {
          const [file, name] = key.split('|');
          return name === model.name && stack.includes(`/src/${file}:`);
        });
        if (!key) return effective;
        const file = key.split('|')[0];
        const location =
          stack.split('\n').find((line) => line.includes(`/src/${file}:`)) ??
          '';
        return new Proxy(effective, {
          construct(target, args) {
            const instance = Reflect.construct(target, args);
            expect(instance.constructor).toBe(app?.[model.name] ?? model);
            const locations = seen.get(key) ?? new Set<string>();
            locations.add(location);
            seen.set(key, locations);
            return instance;
          },
        });
      });
    restoreSpy = () => spy.mockRestore();
  });
  afterEach(() => restoreSpy?.());
  afterAll(() => {
    restoreRegistry?.();
    expect(
      Object.fromEntries(
        Object.keys(expectedSites).map((key) => [
          key,
          seen.get(key)?.size ?? 0,
        ]),
      ),
    ).toEqual(expectedSites);
  });
  describe('allocation workflows', () => {
    let db: DatabaseInterface;
    beforeEach(async () => {
      db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    });
    afterEach(async () => {
      await db?.close();
    });
    defineAllocationSuite(() => db);
  });
});
