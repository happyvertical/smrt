import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, it } from 'vitest';
import {
  assertBundleCourseMigration,
  bundleCourseMigrationClasses,
} from './course-bundle-course-migration.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? it : it.skip)(
  'adds the bundle course tables and material rendition columns to populated PostgreSQL additively',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: bundleCourseMigrationClasses,
    });
    try {
      await assertBundleCourseMigration(isolated.baseDb, 'postgres');
    } finally {
      await isolated.cleanup();
    }
  },
);
