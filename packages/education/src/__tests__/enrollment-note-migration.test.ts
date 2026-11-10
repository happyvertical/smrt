import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, it } from 'vitest';
import { assertEnrollmentNoteMigration } from './enrollment-note-migration.js';
import { learnerClasses } from './learner-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
it('migrates populated pre-notes SQLite with the canonical additive manifest diff', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [...learnerClasses, 'EnrollmentParentNote'],
  });
  try {
    await assertEnrollmentNoteMigration(db, 'sqlite');
  } finally {
    await db.close?.();
  }
});
