import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, it } from 'vitest';
import { assertLearnerInterestThemeMigration } from './learner-interest-theme-migration.js';
import { learnerClasses } from './learner-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
it('adds the theme columns and change table to populated pre-theme SQLite with the canonical additive diff', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [...learnerClasses, 'LearnerInterestThemeChange'],
  });
  try {
    await assertLearnerInterestThemeMigration(db, 'sqlite');
  } finally {
    await db.close?.();
  }
});
