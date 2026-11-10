import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertAuthorizedPagination,
  assertLessonAssetTenantKey,
  assertVideoUrlPersistence,
} from './external-review-regression.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('external catalog review regressions (SQLite)', () => {
  for (const [name, check] of [
    [
      'retains Video URL through create and hydration',
      assertVideoUrlPersistence,
    ],
    ['paginates only authorized courses', assertAuthorizedPagination],
    [
      'scopes asset key and retries by tenant including null',
      assertLessonAssetTenantKey,
    ],
  ] as const) {
    it(name, async () => {
      const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
      try {
        await check(db);
      } finally {
        await db.close?.();
      }
    });
  }
});
