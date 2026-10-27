import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe } from 'vitest';
import { workbookLayoutContractTests } from './workbook-layout-workflows.js';
import { workbookClasses } from './workbook-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('WorkbookService observed layout sqlite', () =>
  workbookLayoutContractTests(async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        ...workbookClasses,
        'WorkbookPhotoDecision',
        'WorkbookContextRevision',
      ],
    });
    return {
      db,
      cleanup: async () => {
        await db.close?.();
      },
    };
  }));
