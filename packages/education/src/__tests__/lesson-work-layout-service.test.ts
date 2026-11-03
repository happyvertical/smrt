import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe } from 'vitest';
import { workbookLayoutContractTests } from './lesson-work-layout-workflows.js';
import { workbookClasses } from './lesson-work-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('LessonWorkService observed layout sqlite', () =>
  workbookLayoutContractTests(async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        ...workbookClasses,
        'WorkbookPhotoDecision',
        'BookContextRevision',
      ],
    });
    return {
      db,
      cleanup: async () => {
        await db.close?.();
      },
    };
  }));
