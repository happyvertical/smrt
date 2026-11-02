import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe } from 'vitest';
import { workbookCompletionContractTests } from './workbook-completion-workflows.js';
import { workbookClasses } from './workbook-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('Workbook explicit completion sqlite', () =>
  workbookCompletionContractTests(async () => {
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
