import { randomUUID } from 'node:crypto';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  resetTenancy,
  setupTestTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import { clearFieldPolicyCache } from '../cache.js';
import { FieldUsageCounterCollection } from '../collections/FieldUsageCounterCollection.js';
import { FieldUsageCounter } from '../models/FieldUsageCounter.js';

/** Observe real construction without changing constructor identity or lifecycle.
 * Distinct service stack locations ensure every swept site is exercised. */
const expectedSites: Record<string, number> = {
  'collections/FieldUsageCounterCollection.ts|FieldUsageCounter': 1,
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
  it('builds the effective counter for a new usage bucket', async () => {
    setupTestTenancy();
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const tenantId = randomUUID();
    try {
      const counters = await FieldUsageCounterCollection.create({ db });
      const objectRef =
        ObjectRegistry.getEffectiveClassByConstructor(
          FieldUsageCounter,
        )?.qualifiedName;
      if (!objectRef) throw new Error('Missing counter registration');
      await withTenant(
        { tenantId, userId: randomUUID(), permissions: new Set<string>() },
        async () => {
          const result = await counters.reportUsage({
            entries: [{ objectRef, fieldName: 'period', value: '2026-11-12' }],
          });
          expect(result.accepted).toBe(1);
          const rows = await counters.list({});
          expect(rows).toHaveLength(1);
          expect(rows[0].constructor).toBe(
            app?.FieldUsageCounter ?? FieldUsageCounter,
          );
          expect(rows[0].submissionCount).toBe(1);
        },
      );
    } finally {
      clearFieldPolicyCache();
      resetTenancy();
      await db.close?.();
    }
  });
});
