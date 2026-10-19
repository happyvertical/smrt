import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertCatalogRequestWhitelist,
  assertHostileLearnerLinks,
  assertInflightRollback,
  assertLearnerAuthorization,
  assertLearnerModels,
  assertLearnerRollback,
  assertLearnerSetupStatus,
  assertProgressHistory,
  assertQueuedRollbackAndClosure,
  assertTransactionDrain,
  learnerClasses,
  learnerFixture,
} from './learner-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'LearnerService PostgreSQL',
  () => {
    for (const [name, assertion] of Object.entries({
      authorization: assertLearnerAuthorization,
      setupStatus: assertLearnerSetupStatus,
      history: assertProgressHistory,
      rollback: assertLearnerRollback,
      models: assertLearnerModels,
      assertHostileLearnerLinks,
      queuedRollback: assertQueuedRollbackAndClosure,
      transactionDrain: assertTransactionDrain,
      inflightRollback: assertInflightRollback,
      catalogRequestWhitelist: assertCatalogRequestWhitelist,
    })) {
      it(name, async () => {
        const isolated = await createIsolatedTestDbFromManifest({
          includeObjects: learnerClasses,
        });
        try {
          await assertion(await learnerFixture(isolated.baseDb));
        } finally {
          await isolated.cleanup();
        }
      });
    }
  },
);
