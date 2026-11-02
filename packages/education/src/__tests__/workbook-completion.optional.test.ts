import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe } from 'vitest';
import { workbookCompletionContractTests } from './workbook-completion-workflows.js';
import { workbookClasses } from './workbook-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'Workbook explicit completion postgres',
  () =>
    workbookCompletionContractTests(async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: workbookClasses,
      });
      return { db: isolated.baseDb, cleanup: isolated.cleanup };
    }),
);
