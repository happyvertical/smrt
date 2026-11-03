import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  workbookClasses,
  workbookContractTests,
} from './lesson-work-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('LessonWorkService durable workflow sqlite', () =>
  workbookContractTests(async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: workbookClasses,
    });
    return {
      db,
      cleanup: async () => {
        await db.close?.();
      },
    };
  }));
