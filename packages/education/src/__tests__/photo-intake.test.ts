import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe } from 'vitest';
import { photoClasses, photoIntakeTests } from './photo-intake-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('photo-first intake SQLite', () =>
  photoIntakeTests(async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: photoClasses,
    });
    return {
      db,
      cleanup: async () => {
        await db.close?.();
      },
    };
  }));
