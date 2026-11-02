import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFailingAutoUpgradeAuthorizerIsIsolated,
  autoUpgradeClasses,
} from './course-authoring-auto-upgrade-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'Course authoring PostgreSQL',
  () => {
    it('isolates a failing auto-upgrade authorizer statement', async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: autoUpgradeClasses,
      });
      try {
        await assertFailingAutoUpgradeAuthorizerIsIsolated(isolated.baseDb);
      } finally {
        await isolated.cleanup();
      }
    });
  },
);
