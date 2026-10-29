import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDb,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe } from 'vitest';
import { familyMigrationTests } from './family-intake-migration-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'family intake schema upgrade PostgreSQL',
  () =>
    familyMigrationTests('postgres', async (schema) => {
      const baseUrl =
        process.env.SMRT_TEST_POSTGRES_ADMIN_URL ?? process.env.DATABASE_URL;
      if (!baseUrl)
        throw new Error('PostgreSQL migration requires an admin URL');
      const admin = await getTestDatabase({
        type: 'postgres',
        url: baseUrl,
        classes: [],
        includeSystemTables: false,
      });
      const databaseName = `family_upgrade_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(baseUrl);
      url.pathname = `/${databaseName}`;
      const previousUrl = process.env.DATABASE_URL;
      let baseline: Awaited<ReturnType<typeof createIsolatedTestDb>>;
      try {
        process.env.DATABASE_URL = url.toString();
        baseline = await createIsolatedTestDb({ schema });
      } catch (error) {
        await admin.query(`DROP DATABASE "${databaseName}"`);
        await admin.close?.();
        throw error;
      } finally {
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
      }
      await baseline.db.rollback();
      return {
        db: baseline.baseDb,
        cleanup: async () => {
          await baseline.cleanup();
          try {
            await admin.query(`DROP DATABASE "${databaseName}"`);
          } finally {
            await admin.close?.();
          }
        },
        restart: async () => {
          await baseline.baseDb.close?.();
          return getTestDatabase({
            type: 'postgres',
            url: url.toString(),
            classes: [],
            includeSystemTables: false,
          });
        },
      };
    }),
);
