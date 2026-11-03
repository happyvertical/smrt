import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, it } from 'vitest';
import { assertWorkbookMigration } from './course-work-migration-workflows.js';
import { workbookClasses } from './lesson-work-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? it : it.skip)(
  'migrates populated PostgreSQL workbooks into book courses losslessly and idempotently',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        ...workbookClasses,
        'BookContextRevision',
        'WorkbookPhotoDecision',
      ],
    });
    try {
      await assertWorkbookMigration(isolated.baseDb, 'postgres');
    } finally {
      await isolated.cleanup();
    }
  },
);
