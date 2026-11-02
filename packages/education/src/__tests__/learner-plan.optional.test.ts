import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
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
(isPostgresAvailable() ? describe : describe.skip)(
  'Learner Plan PostgreSQL',
  () => {
    for (const [name, assertion] of Object.entries({
      projection: assertPlanProjection,
      progress: assertPlanProgress,
      workbook: assertPlanWorkbookBinding,
      unavailable: assertPlanUnavailableIsolation,
      online: assertPlanOnlineSources,
    }))
      it(name, async () => {
        const isolated = await createIsolatedTestDbFromManifest({
          includeObjects: [...workbookClasses, 'EnrollmentParentNote'],
        });
        try {
          await assertion(await planFixture(isolated.baseDb));
        } finally {
          await isolated.cleanup();
        }
      });
  },
);
