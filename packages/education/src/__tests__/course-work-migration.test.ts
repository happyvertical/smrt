import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, it } from 'vitest';
import { assertWorkbookMigration } from './course-work-migration-workflows.js';
import { workbookClasses } from './lesson-work-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
it('migrates populated SQLite workbooks into book courses losslessly and idempotently', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [
      ...workbookClasses,
      'BookContextRevision',
      'WorkbookPhotoDecision',
    ],
  });
  try {
    await assertWorkbookMigration(db, 'sqlite');
  } finally {
    await db.close?.();
  }
});
