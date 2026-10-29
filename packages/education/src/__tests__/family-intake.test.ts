import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe } from 'vitest';
import { familyClasses, familyIntakeTests } from './family-intake-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('family-owned intake SQLite', () =>
  familyIntakeTests(async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: familyClasses,
    });
    return {
      db,
      cleanup: async () => {
        await db.close?.();
      },
    };
  }));
