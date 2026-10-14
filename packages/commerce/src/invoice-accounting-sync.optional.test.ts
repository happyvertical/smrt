import { randomUUID } from 'node:crypto';
import type {
  AccountingProvider,
  InvoiceInput,
  SyncResult,
} from '@happyvertical/accounting';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerCollection } from './collections/CustomerCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from './collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from './collections/TaxCodeCollection.js';
import { TaxComponentCollection } from './collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from './collections/TaxSettingsCollection.js';
import {
  type QuickBooksFrozenInvoiceMapping,
  readFrozenAccountingSyncState,
  reconcileFrozenInvoiceAccountingSync,
  syncFrozenInvoiceToAccounting,
} from './invoice-accounting-sync.js';
import { ensureTenantTaxCodes } from './tax/legacy.js';
import { InvoiceStatus } from './types/index.js';

describe('frozen invoice accounting sync on PostgreSQL (#3937)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    db = await getTestDatabase({
      type: 'postgres',
      url: process.env.DATABASE_URL,
    });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('persists ownership, reconciles absence, retries identically, and no-ops success', async () => {
    const tenantId = randomUUID();
    await ensureTenantTaxCodes(db, tenantId);
    await withTenant({ tenantId }, async () => {
      const component = await (
        await TaxComponentCollection.create({ db })
      ).create({ name: 'GST', percent: '5' });
      const code = await (await TaxCodeCollection.create({ db })).create({
        code: 'gst-pg',
        name: 'GST',
        components: [{ taxComponentId: component.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const current = await settings.getOrCreateForTenant(tenantId);
      current.defaultSalesTaxCodeId = code.id;
      current.defaultLineAmountType = 'exclusive';
      current.taxRoundingScope = 'document';
      await current.save();
      const migrationId = await settings.beginMoneyMigration(tenantId);
      await settings.activateMoneyV2(tenantId, migrationId);

      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: code.id,
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        customerExternalId: 'qbo-pg-customer',
        invoiceNumber: `INV-PG-${randomUUID()}`,
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        invoiceId: invoice.id,
        description: 'PostgreSQL consulting',
        quantity: 2,
        unitPrice: 100,
        taxMode: 'override',
        taxCodeId: code.id,
      });
      const issued = await invoices.get({ id: invoice.id }, { cache: false });
      if (!issued) throw new Error('Expected invoice');
      issued.status = InvoiceStatus.SENT;
      await issued.save();

      const mapping: QuickBooksFrozenInvoiceMapping = {
        realmId: 'realm-postgres',
        environment: 'sandbox',
        lines: {
          [line.id]: { itemRef: 'item-pg', taxCodeRef: 'tax-pg' },
        },
        components: {
          [component.id]: { quickbooksTaxRateRef: 'rate-pg' },
        },
      };
      let rejectFirst!: (error: Error) => void;
      const firstProviderCall = new Promise<SyncResult>((_resolve, reject) => {
        rejectFirst = reject;
      });
      const requests: string[] = [];
      const push = vi.fn(async (input: InvoiceInput): Promise<SyncResult> => {
        requests.push(JSON.stringify(input.quickbooksRequest));
        if (requests.length === 1) return firstProviderCall;
        return {
          action: 'created',
          externalId: 'qbo-pg-invoice',
          syncedAt: new Date('2026-10-14T13:00:00.000Z'),
        };
      });
      const provider: Pick<AccountingProvider, 'type' | 'invoices'> = {
        type: 'quickbooks',
        invoices: { push } as AccountingProvider['invoices'],
      };
      const input = {
        db,
        tenantId,
        invoiceId: invoice.id,
        mapping,
        provider,
      };

      const first = syncFrozenInvoiceToAccounting(input);
      await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
      await expect(syncFrozenInvoiceToAccounting(input)).rejects.toMatchObject({
        code: 'ACCOUNTING_SYNC_IN_PROGRESS',
      });
      const owned = await invoices.get({ id: invoice.id }, { cache: false });
      if (!owned) throw new Error('Expected owned invoice');
      expect(readFrozenAccountingSyncState(owned)).toMatchObject({
        status: 'in_flight',
        realmId: 'realm-postgres',
        environment: 'sandbox',
        moneySnapshotId: issued.moneySnapshotId,
        requestId: expect.stringMatching(/^smrt_[a-f0-9]{40}$/),
        attemptId: expect.any(String),
      });

      rejectFirst(new Error('connection lost after provider write'));
      await expect(first).rejects.toThrow(
        'connection lost after provider write',
      );
      const unknown = await invoices.get({ id: invoice.id }, { cache: false });
      if (!unknown) throw new Error('Expected unresolved invoice');
      const state = readFrozenAccountingSyncState(unknown);
      if (!state) throw new Error('Expected unresolved state');
      expect(state.status).toBe('unknown');

      await expect(
        reconcileFrozenInvoiceAccountingSync({
          db,
          tenantId,
          invoiceId: invoice.id,
          mapping,
          requestId: state.requestId,
          attemptId: state.attemptId,
          outcome: { status: 'absent' },
        }),
      ).resolves.toMatchObject({
        status: 'ready',
        requestId: state.requestId,
      });
      await expect(syncFrozenInvoiceToAccounting(input)).resolves.toMatchObject(
        { status: 'synced', externalId: 'qbo-pg-invoice' },
      );
      await expect(syncFrozenInvoiceToAccounting(input)).resolves.toMatchObject(
        { status: 'unchanged', externalId: 'qbo-pg-invoice' },
      );
      expect(push).toHaveBeenCalledTimes(2);
      expect(requests[1]).toBe(requests[0]);
    });
  }, 120_000);
});
