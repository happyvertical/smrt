import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertDelegatedGuardianReview,
  assertIngestionBridge,
  ingestionClasses,
} from './ingestion-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'ingestion bridge PostgreSQL',
  () => {
    it('delegated learner-to-guardian execution', async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: ingestionClasses,
      });
      try {
        await assertDelegatedGuardianReview(isolated.baseDb);
      } finally {
        await isolated.cleanup();
      }
    });
    it('real receipt/capture and borrowed transaction rollback/correction', async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: ingestionClasses,
      });
      try {
        await assertIngestionBridge(isolated.baseDb);
      } finally {
        await isolated.cleanup();
      }
    });
  },
);
