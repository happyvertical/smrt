import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe } from 'vitest';
import { workbookLayoutContractTests } from './workbook-layout-workflows.js';
import { workbookClasses } from './workbook-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'WorkbookService observed layout postgres',
  () =>
    workbookLayoutContractTests(async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
          ...workbookClasses,
          'WorkbookPhotoDecision',
          'WorkbookContextRevision',
        ],
      });
      return { db: isolated.baseDb, cleanup: isolated.cleanup };
    }),
);
