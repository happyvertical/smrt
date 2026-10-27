import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe } from 'vitest';
import { photoClasses, photoIntakeTests } from './photo-intake-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'photo-first intake PostgreSQL',
  () =>
    photoIntakeTests(async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: photoClasses,
      });
      return { db: isolated.baseDb, cleanup: isolated.cleanup };
    }),
);
