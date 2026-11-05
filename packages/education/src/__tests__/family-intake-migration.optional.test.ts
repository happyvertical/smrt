import { randomUUID } from 'node:crypto';
import { ensureSystemTables, getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe } from 'vitest';
import { familyMigrationTests } from './family-intake-migration-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'family intake schema upgrade PostgreSQL',
  () =>
    familyMigrationTests('postgres', async (statements) => {
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
      const url = new URL(baseUrl);
      url.pathname = `/${databaseName}`;
      const open = () =>
        getTestDatabase({
          type: 'postgres',
          url: url.toString(),
          classes: [],
          includeSystemTables: false,
        });
      const drop = async () => {
        try {
          await admin.query(`DROP DATABASE "${databaseName}"`);
        } finally {
          await admin.close?.();
        }
      };
      try {
        await admin.query(`CREATE DATABASE "${databaseName}"`);
      } catch (error) {
        await admin.close?.();
        throw error;
      }
      let db: Awaited<ReturnType<typeof open>> | undefined;
      try {
        db = await open();
        // Apply the historical schema exactly, including dollar-quoted index
        // blocks that contain semicolons inside a single PostgreSQL statement.
        for (const statement of statements) await db.query(statement);
        await ensureSystemTables(db, 'postgres');
      } catch (error) {
        try {
          await db?.close?.();
        } finally {
          await drop();
        }
        throw error;
      }
      return {
        db,
        cleanup: async () => {
          try {
            await db.close?.();
          } finally {
            await drop();
          }
        },
        restart: async () => {
          await db.close?.();
          return open();
        },
      };
    }),
);
