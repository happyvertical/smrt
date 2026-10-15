import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { withDocumentMoneyTransaction } from '../document-money-internal.js';
import {
  lockTenantMoneyRuntime,
  withTenantMoneyMigration,
  withTenantMoneyRuntime,
} from '../tenant-money-barrier.js';

describe('tenant money runtime barrier (#3933)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('keeps an absent settings table read-only legacy and refuses v2', async () => {
    const transaction = vi.fn(
      async <T>(operation: (tx: DatabaseInterface) => Promise<T>) =>
        operation({
          tableExists: async () => false,
          transaction: async () => {
            throw new Error('nested transaction');
          },
        } as unknown as DatabaseInterface),
    );
    const root = { transaction } as unknown as DatabaseInterface;

    const result = await withTenantMoneyRuntime(
      root,
      'tenant-a',
      'legacy-or-v2',
      async (scope) => {
        expect(scope.barrier).toEqual({
          moneyModel: 'legacy',
          settings: null,
          persistedBarrier: false,
        });
        return withTenantMoneyRuntime(
          scope.db,
          'tenant-a',
          'legacy-or-v2',
          async (nested) => nested.db === scope.db,
          scope,
        );
      },
    );

    expect(result).toBe(true);
    expect(transaction).toHaveBeenCalledOnce();
    await expect(
      withTenantMoneyRuntime(root, 'tenant-a', 'v2', async () => undefined),
    ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
  });

  it('does not mistake a base executor without beginTransaction for a scope', async () => {
    const bound = {
      tableExists: async () => false,
    } as unknown as DatabaseInterface;
    const transaction = vi.fn(
      async <T>(operation: (tx: DatabaseInterface) => Promise<T>) =>
        operation(bound),
    );
    const baseWithoutBegin = {
      transaction,
      tableExists: async () => false,
    } as unknown as DatabaseInterface;

    await withTenantMoneyRuntime(
      baseWithoutBegin,
      'tenant-a',
      'legacy-or-v2',
      async (scope) => expect(scope.db).toBe(bound),
    );
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('materializes one legacy marker and serializes every transition', async () => {
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const observed = await withTenantMoneyRuntime(
        db,
        'tenant-a',
        'legacy-or-v2',
        async (scope) => {
          expect(scope.barrier).toMatchObject({
            moneyModel: 'legacy',
            persistedBarrier: true,
          });
          const nested = await withTenantMoneyRuntime(
            scope.db,
            'tenant-a',
            'legacy-or-v2',
            async (inner) => inner,
          );
          expect(nested).toBe(scope);
          return scope.barrier.settings?.id;
        },
      );
      expect(observed).toBeTruthy();
      const settings = await TaxSettingsCollection.create({ db });
      expect(
        await settings.list({ where: { tenantId: 'tenant-a' } }),
      ).toHaveLength(1);

      const migrationId = await settings.beginMoneyMigration('tenant-a');
      await expect(
        withTenantMoneyRuntime(
          db,
          'tenant-a',
          'legacy-or-v2',
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
      await settings.restoreLegacyMoneyModel('tenant-a', migrationId);
      await expect(
        withTenantMoneyRuntime(
          db,
          'tenant-a',
          'legacy-or-v2',
          async (scope) => scope.barrier.moneyModel,
        ),
      ).resolves.toBe('legacy');
    });
  });

  it('reuses the exact registered executor and rolls back marker creation', async () => {
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      let executor: DatabaseInterface | undefined;
      await expect(
        withDocumentMoneyTransaction(db, async (tx) => {
          executor = tx;
          return withTenantMoneyRuntime(
            tx,
            'tenant-a',
            'legacy-or-v2',
            async (scope) => {
              expect(scope.db).toBe(tx);
              throw new Error('rollback barrier');
            },
          );
        }),
      ).rejects.toThrow('rollback barrier');
      expect(executor).toBeDefined();
      const settings = await TaxSettingsCollection.create({ db });
      expect(await settings.getForTenant('tenant-a')).toBeNull();
    });
  });

  it('rejects an explicit scope for another executor or tenant', async () => {
    await withTenant({ tenantId: 'tenant-a' }, () =>
      withTenantMoneyRuntime(db, 'tenant-a', 'legacy-or-v2', async (scope) => {
        await expect(
          withTenantMoneyRuntime(
            {} as DatabaseInterface,
            'tenant-a',
            'legacy-or-v2',
            async () => undefined,
            scope,
          ),
        ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
        await expect(
          withTenantMoneyRuntime(
            scope.db,
            'tenant-b',
            'legacy-or-v2',
            async () => undefined,
            scope,
          ),
        ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
      }),
    );
  });

  it('keeps direct lock primitive usable by an owning transaction scope', async () => {
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await withDocumentMoneyTransaction(db, async (tx) => {
        await expect(
          lockTenantMoneyRuntime(tx, 'tenant-a'),
        ).resolves.toMatchObject({ moneyModel: 'legacy' });
      });
    });
  });

  it('guards generated invoice and line get/list reads while migrating', async () => {
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({ invoiceNumber: 'BARRIER-1' });
      const lines = await InvoiceLineItemCollection.create({ db });
      const line = await lines.create({
        invoiceId: invoice.id,
        description: 'Barrier line',
        quantity: 1,
        unitPrice: 100,
      });
      const settings = await TaxSettingsCollection.create({ db });
      const migrationId = await settings.beginMoneyMigration('tenant-a');

      await expect(invoices.get({ id: invoice.id })).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
      await expect(invoices.list()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
      await expect(lines.get({ id: line.id })).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
      await expect(lines.list()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });

      await withTenantMoneyMigration(
        db,
        'tenant-a',
        migrationId,
        async (scope) => {
          const ownedInvoices = await InvoiceCollection.create({
            db: scope.db,
          });
          const ownedLines = await InvoiceLineItemCollection.create({
            db: scope.db,
          });
          await expect(
            ownedInvoices.get({ id: invoice.id }),
          ).resolves.toMatchObject({ id: invoice.id });
          await expect(ownedInvoices.list()).resolves.toHaveLength(1);
          await expect(ownedLines.get({ id: line.id })).resolves.toMatchObject({
            id: line.id,
          });
          await expect(ownedLines.list()).resolves.toHaveLength(1);
          await expect(
            withTenantMoneyMigration(
              scope.db,
              'tenant-a',
              'wrong-owner',
              async () => undefined,
            ),
          ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
        },
      );

      await settings.restoreLegacyMoneyModel('tenant-a', migrationId);
      await expect(invoices.get({ id: invoice.id })).resolves.toMatchObject({
        id: invoice.id,
      });
    });
  });

  it('refuses a new settings row that would upsert over the tenant marker', async () => {
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      await settings.getOrCreateForTenant('tenant-a');
      const migrationId = await settings.beginMoneyMigration('tenant-a');

      // A generated create carries only writable fields, so the marker
      // defaults to legacy; the tenant_id natural key would adopt the row.
      await expect(
        settings.create({ tenantId: 'tenant-a', taxRoundingScope: 'document' }),
      ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
      await expect(settings.getForTenant('tenant-a')).resolves.toMatchObject({
        moneyModel: 'migrating',
        moneyMigrationId: migrationId,
      });

      await settings.activateMoneyV2('tenant-a', migrationId);
      await expect(
        settings.create({ tenantId: 'tenant-a', taxRoundingScope: 'document' }),
      ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
      await expect(settings.getForTenant('tenant-a')).resolves.toMatchObject({
        moneyModel: 'v2',
        taxRoundingScope: 'line',
      });
    });
  });
});
