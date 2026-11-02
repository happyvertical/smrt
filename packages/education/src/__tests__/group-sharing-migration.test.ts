import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  groupSharingMigrationBaseClasses,
  groupSharingMigrationContractTests,
} from './group-sharing-migration-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('group sharing existing SQLite schema upgrade', () => {
  groupSharingMigrationContractTests(async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: groupSharingMigrationBaseClasses,
    });
    return {
      db,
      cleanup: async () => {
        await db.close?.();
      },
    };
  });
});
