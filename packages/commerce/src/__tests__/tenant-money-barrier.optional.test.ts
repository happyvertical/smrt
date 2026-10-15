import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { withTenantMoneyRuntime } from '../tenant-money-barrier.js';
import { seedLegacyMoneyTenant } from './helpers/legacy-money-tenant.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('tenant money runtime barrier on PostgreSQL (#3933)', () => {
  let db: DatabaseInterface;
  let peer: DatabaseInterface;

  beforeEach(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    db = await getTestDatabase({
      type: 'postgres',
      url: process.env.DATABASE_URL,
    });
    peer = await getTestDatabase({
      type: 'postgres',
      url: process.env.DATABASE_URL,
    });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await peer?.close?.();
    await db?.close?.();
  });

  it('holds runtime and migration on the same tenant marker row', async () => {
    const tenantId = randomUUID();
    await seedLegacyMoneyTenant(db, tenantId);
    await withTenant({ tenantId }, () =>
      withTenantMoneyRuntime(
        db,
        tenantId,
        'legacy-or-v2',
        async () => undefined,
      ),
    );

    let releaseRuntime!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    let runtimeLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      runtimeLocked = resolve;
    });
    const holder = withTenant({ tenantId }, () =>
      withTenantMoneyRuntime(db, tenantId, 'legacy-or-v2', async (scope) => {
        expect(scope.db).not.toBe(db);
        runtimeLocked();
        await release;
      }),
    );
    await locked;

    let migrationSettled = false;
    const migration = withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db: peer });
      return settings.beginMoneyMigration(tenantId);
    }).finally(() => {
      migrationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(migrationSettled).toBe(false);

    releaseRuntime();
    await holder;
    const migrationId = await migration;
    expect(migrationId).toBeTruthy();
    await expect(
      withTenant({ tenantId }, () =>
        withTenantMoneyRuntime(
          db,
          tenantId,
          'legacy-or-v2',
          async () => undefined,
        ),
      ),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
    await withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      await settings.restoreLegacyMoneyModel(tenantId, migrationId);
    });
  });

  it('does not block a different tenant marker', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await seedLegacyMoneyTenant(db, tenantA, tenantB);
    for (const tenantId of [tenantA, tenantB]) {
      await withTenant({ tenantId }, () =>
        withTenantMoneyRuntime(
          db,
          tenantId,
          'legacy-or-v2',
          async () => undefined,
        ),
      );
    }

    let releaseA!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let lockedA!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockedA = resolve;
    });
    const holder = withTenant({ tenantId: tenantA }, () =>
      withTenantMoneyRuntime(db, tenantA, 'legacy-or-v2', async () => {
        lockedA();
        await release;
      }),
    );
    await locked;
    await expect(
      withTenant({ tenantId: tenantB }, async () => {
        const settings = await TaxSettingsCollection.create({ db: peer });
        return settings.beginMoneyMigration(tenantB);
      }),
    ).resolves.toBeTruthy();
    releaseA();
    await holder;
  });

  it('refuses a natural-key settings upsert that would reset the marker', async () => {
    const tenantId = randomUUID();
    await withTenant({ tenantId }, async () => {
      await seedLegacyMoneyTenant(db, tenantId);
      const settings = await TaxSettingsCollection.create({ db });
      const migrationId = await settings.beginMoneyMigration(tenantId);

      await expect(
        settings.create({ tenantId, taxRoundingScope: 'document' }),
      ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
      await expect(settings.getForTenant(tenantId)).resolves.toMatchObject({
        moneyModel: 'migrating',
        moneyMigrationId: migrationId,
      });

      await settings.activateMoneyV2(tenantId, migrationId);
      await expect(
        settings.create({ tenantId, taxRoundingScope: 'document' }),
      ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
      await expect(settings.getForTenant(tenantId)).resolves.toMatchObject({
        moneyModel: 'v2',
        taxRoundingScope: 'line',
      });
    });
  });

  it('serializes a natural-key settings upsert with a racing migration claim', async () => {
    const tenantId = randomUUID();
    await seedLegacyMoneyTenant(db, tenantId);

    const originalTransaction = db.transaction?.bind(db);
    if (!originalTransaction) throw new Error('transaction support required');
    let releaseCreate!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let markerLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markerLocked = resolve;
    });
    let paused = false;
    Object.assign(db, {
      transaction: async (
        operation: (transaction: DatabaseInterface) => Promise<unknown>,
      ) =>
        originalTransaction(async (transaction) => {
          const originalQuery = transaction.query.bind(transaction);
          Object.assign(transaction, {
            query: async (...args: Parameters<typeof transaction.query>) => {
              const result = await originalQuery(...args);
              const sql = args[0];
              if (
                !paused &&
                typeof sql === 'string' &&
                sql.includes('UPDATE "tax_settings"') &&
                sql.includes('RETURNING "id"')
              ) {
                paused = true;
                markerLocked();
                await release;
              }
              return result;
            },
          });
          return operation(transaction);
        }),
    });

    const create = withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      return settings.create({ tenantId, taxRoundingScope: 'document' });
    });
    await locked;

    let migrationSettled = false;
    const migration = withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db: peer });
      return settings.beginMoneyMigration(tenantId);
    }).finally(() => {
      migrationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(migrationSettled).toBe(false);

    releaseCreate();
    await expect(create).resolves.toMatchObject({
      tenantId,
      moneyModel: 'legacy',
    });
    const migrationId = await migration;
    await withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db: peer });
      await expect(settings.getForTenant(tenantId)).resolves.toMatchObject({
        moneyModel: 'migrating',
        moneyMigrationId: migrationId,
      });
      await settings.restoreLegacyMoneyModel(tenantId, migrationId);
    });
  });

  it('serializes a clean tenant first settings save ahead of a racing migration claim', async () => {
    const tenantId = randomUUID();
    const originalTransaction = db.transaction?.bind(db);
    if (!originalTransaction) throw new Error('transaction support required');
    let releaseCreate!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let markerChecked!: () => void;
    const checked = new Promise<void>((resolve) => {
      markerChecked = resolve;
    });
    let paused = false;
    Object.assign(db, {
      transaction: async (
        operation: (transaction: DatabaseInterface) => Promise<unknown>,
      ) =>
        originalTransaction(async (transaction) => {
          const originalQuery = transaction.query.bind(transaction);
          Object.assign(transaction, {
            query: async (...args: Parameters<typeof transaction.query>) => {
              const result = await originalQuery(...args);
              const sql = args[0];
              if (
                !paused &&
                typeof sql === 'string' &&
                sql.trimStart().toUpperCase().startsWith('SELECT') &&
                sql.includes('tax_settings')
              ) {
                paused = true;
                markerChecked();
                await release;
              }
              return result;
            },
          });
          return operation(transaction);
        }),
    });

    const create = withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      return settings.create({ tenantId, taxRoundingScope: 'document' });
    });
    await checked;
    // The paused first save holds the tenant's first-marker advisory lock, so
    // the migration claim waits instead of creating a competing marker.
    let migrationSettled = false;
    const migration = withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db: peer });
      return settings.beginMoneyMigration(tenantId);
    }).finally(() => {
      migrationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(migrationSettled).toBe(false);
    releaseCreate();

    // With no documents the first save chooses v2 (#4009), so the claim that
    // follows it finds a tenant with nothing to migrate.
    await expect(create).resolves.toMatchObject({ tenantId, moneyModel: 'v2' });
    await expect(migration).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
    await withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db: peer });
      await expect(settings.getForTenant(tenantId)).resolves.toMatchObject({
        moneyModel: 'v2',
        moneyMigrationId: '',
      });
    });
  });

  it('lets migration claim a legacy marker created first by an ordinary save', async () => {
    const tenantId = randomUUID();
    await withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      await expect(
        settings.create({ tenantId, moneyModel: 'legacy' }),
      ).resolves.toMatchObject({ moneyModel: 'legacy' });
    });

    const migrationId = await withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db: peer });
      return settings.beginMoneyMigration(tenantId);
    });
    await withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      await expect(settings.getForTenant(tenantId)).resolves.toMatchObject({
        moneyModel: 'migrating',
        moneyMigrationId: migrationId,
      });
      await settings.restoreLegacyMoneyModel(tenantId, migrationId);
    });
  });
});
