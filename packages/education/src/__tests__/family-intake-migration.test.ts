import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { createIsolatedTestDb } from '@happyvertical/smrt-vitest';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe } from 'vitest';
import { familyMigrationTests } from './family-intake-migration-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('family intake schema upgrade SQLite', () =>
  familyMigrationTests('sqlite', async (statements) => {
    const isolated = await createIsolatedTestDb({
      schema: statements.join(';\n'),
    });
    await isolated.db.rollback();
    return {
      db: isolated.baseDb,
      cleanup: isolated.cleanup,
      restart: async () => {
        await isolated.baseDb.close?.();
        return getDatabase({ ...isolated.config, cache: false });
      },
    };
  }));
