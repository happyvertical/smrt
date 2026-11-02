import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, it } from 'vitest';
import { assertEnrollmentPaceMigration } from './enrollment-pace-migration.js';
import { learnerClasses } from './learner-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
it('adds the pace column and change table to populated pre-pace SQLite with the canonical additive diff', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [...learnerClasses, 'EnrollmentPaceChange'],
  });
  try {
    await assertEnrollmentPaceMigration(db, 'sqlite');
  } finally {
    await db.close?.();
  }
});
