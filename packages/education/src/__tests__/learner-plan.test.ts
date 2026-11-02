import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertPlanOnlineSources,
  assertPlanProgress,
  assertPlanProjection,
  assertPlanUnavailableIsolation,
  assertPlanWorkbookBinding,
  planFixture,
} from './learner-plan-workflows.js';
import { workbookClasses } from './workbook-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('Learner Plan SQLite', () => {
  for (const [name, assertion] of Object.entries({
    projection: assertPlanProjection,
    progress: assertPlanProgress,
    workbook: assertPlanWorkbookBinding,
    unavailable: assertPlanUnavailableIsolation,
    online: assertPlanOnlineSources,
  }))
    it(name, async () => {
      const db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: [...workbookClasses, 'EnrollmentParentNote'],
      });
      try {
        await assertion(await planFixture(db));
      } finally {
        await db.close?.();
      }
    });
});
