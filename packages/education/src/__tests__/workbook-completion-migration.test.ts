import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, it } from 'vitest';
import { assertWorkbookCompletionMigration } from './workbook-completion-migration.js';
import { workbookClasses } from './workbook-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
it('additively migrates populated pre-decision SQLite without inventing completion or changing history', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: workbookClasses,
  });
  try {
    await assertWorkbookCompletionMigration(db, 'sqlite');
  } finally {
    await db.close?.();
  }
});
