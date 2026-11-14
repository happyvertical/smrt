import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { registerBuildSchema } from '../build-schema.js';
import {
  collectMigrateRecordInput,
  recordSuccessfulMigrate,
} from '../migrate-record.js';
import { assertDatabaseMigratedForBuild } from '../startup-guard.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)(
  'PostgreSQL strict startup record comparison (#4929)',
  () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      registerBuildSchema(undefined);
    });

    it('refuses a stale record and accepts the matching record on the supplied executor', async () => {
      const restore = snapshotObjectRegistryState();
      ObjectRegistry.clear();
      // The build this process runs (rv1): an app with no tables of its own.
      registerBuildSchema({ objects: {} });
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '');
      const db = await getDatabase({ type: 'postgres', url: pgUrl });
      const rollback = new Error('rollback optional fixture');
      if (!db.transaction) throw new Error('Transaction support required');
      try {
        // Keep shared PG fixtures intact: even ledger/bootstrap writes roll back.
        await expect(
          db.transaction(async (tx) => {
            const scoped = tx as unknown as DatabaseInterface;
            const input = collectMigrateRecordInput();
            await recordSuccessfulMigrate(scoped, {
              engineHint: 'postgres',
              input: { ...input, fingerprint: 'a'.repeat(64) },
            });
            await expect(
              assertDatabaseMigratedForBuild(scoped, {
                engineHint: 'postgres',
              }),
            ).rejects.toThrow('smrt db:migrate');
            await recordSuccessfulMigrate(scoped, {
              engineHint: 'postgres',
              input,
            });
            await expect(
              assertDatabaseMigratedForBuild(scoped, {
                engineHint: 'postgres',
              }),
            ).resolves.toBeUndefined();
            throw rollback;
          }),
        ).rejects.toBe(rollback);
      } finally {
        restore();
        await db.close?.();
      }
    });
  },
);
