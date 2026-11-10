import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  workbookClasses,
  workbookContractTests,
} from './lesson-work-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'LessonWorkService durable workflow postgres',
  () =>
    workbookContractTests(async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: workbookClasses,
      });
      return { db: isolated.baseDb, cleanup: isolated.cleanup };
    }),
);
