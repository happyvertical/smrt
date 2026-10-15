import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
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
describe('LearnerService SQLite', () => {
  for (const [name, assertion] of Object.entries({
    authorization: assertLearnerAuthorization,
    history: assertProgressHistory,
    rollback: assertLearnerRollback,
    models: assertLearnerModels,
    assertHostileLearnerLinks,
  })) {
    it(name, async () => {
      const db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: learnerClasses,
      });
      try {
        await assertion(await learnerFixture(db));
      } finally {
        await db.close?.();
      }
    });
  }
});
