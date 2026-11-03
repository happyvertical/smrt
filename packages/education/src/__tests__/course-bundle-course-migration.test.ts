import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, it } from 'vitest';
import {
  assertBundleCourseMigration,
  bundleCourseMigrationClasses,
} from './course-bundle-course-migration.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

it('adds the bundle course tables and material rendition columns to populated SQLite additively', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: bundleCourseMigrationClasses,
  });
  try {
    await assertBundleCourseMigration(db, 'sqlite');
  } finally {
    await db.close?.();
  }
});
