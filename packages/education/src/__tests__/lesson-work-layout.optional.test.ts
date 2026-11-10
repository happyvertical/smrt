import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe } from 'vitest';
import { workbookLayoutContractTests } from './lesson-work-layout-workflows.js';
import { workbookClasses } from './lesson-work-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'LessonWorkService observed layout postgres',
  () =>
    workbookLayoutContractTests(async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
          ...workbookClasses,
          'WorkbookPhotoDecision',
          'BookContextRevision',
        ],
      });
      return { db: isolated.baseDb, cleanup: isolated.cleanup };
    }),
);
