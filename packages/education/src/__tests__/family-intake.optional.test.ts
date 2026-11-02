import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe } from 'vitest';
import { familyClasses, familyIntakeTests } from './family-intake-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'family-owned intake PostgreSQL',
  () =>
    familyIntakeTests(async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: familyClasses,
      });
      return { db: isolated.baseDb, cleanup: isolated.cleanup };
    }),
);
