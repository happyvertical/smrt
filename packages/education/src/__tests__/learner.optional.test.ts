import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertHostileLearnerLinks,
  assertLearnerAuthorization,
  assertLearnerModels,
  assertLearnerRollback,
  assertProgressHistory,
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
      history: assertProgressHistory,
      rollback: assertLearnerRollback,
      models: assertLearnerModels,
      assertHostileLearnerLinks,
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
