import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  workbookClasses,
  workbookContractTests,
} from './workbook-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'WorkbookService durable workflow postgres',
  () =>
    workbookContractTests(async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: workbookClasses,
      });
      return { db: isolated.baseDb, cleanup: isolated.cleanup };
    }),
);
