import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, it } from 'vitest';
import { assertWorkbookCompletionMigration } from './workbook-completion-migration.js';
import { workbookClasses } from './workbook-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? it : it.skip)(
  'additively migrates populated pre-decision PostgreSQL without inventing completion or changing history',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: workbookClasses,
    });
    try {
      await assertWorkbookCompletionMigration(isolated.baseDb, 'postgres');
    } finally {
      await isolated.cleanup();
    }
  },
);
