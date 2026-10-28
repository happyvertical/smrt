import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDb,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe } from 'vitest';
import { familyMigrationTests } from './family-intake-migration-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'family intake schema upgrade PostgreSQL',
  () =>
    familyMigrationTests('postgres', async (schema) => {
      const isolated = await createIsolatedTestDb({ schema });
      await isolated.db.rollback();
      return {
        db: isolated.baseDb,
        cleanup: isolated.cleanup,
        restart: async () => {
          await isolated.baseDb.close?.();
          return getDatabase({ ...isolated.config, cache: false });
        },
      };
    }),
);
