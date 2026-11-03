import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, it } from 'vitest';
import {
  assertChooseDuringAttach,
  classes,
} from './course-bundle-course-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? it : it.skip)(
  'serializes a review choice made while an attach is in flight on PostgreSQL',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: classes,
    });
    try {
      await assertChooseDuringAttach(isolated.baseDb);
    } finally {
      await isolated.cleanup();
    }
  },
);
