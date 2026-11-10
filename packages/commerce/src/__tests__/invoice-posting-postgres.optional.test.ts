import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  AccountCollection,
  JournalCollection,
} from '@happyvertical/smrt-ledgers';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { InvoiceStatus } from '../types/index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('money-v2 invoice posting on PostgreSQL (#3935)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Account',
        'Customer',
        'DocumentTax',
        'Invoice',
        'InvoiceLineItem',
        'Journal',
        'JournalEntry',
        'PaymentAllocation',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
      ],
    });
    db = isolated.baseDb;
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('serializes concurrent posting and reverses the stored journal exactly once', async () => {
    const tenantId = randomUUID();
    await withTenant({ tenantId }, async () => {
      const accounts = await AccountCollection.create({ db });
      const createAccount = async (
        number: string,
        type: 'asset' | 'revenue' | 'liability',
      ) => {
        const account = await accounts.create({ number, name: number, type });
        account.tenantId = tenantId;
        await account.save();
        return account;
      };
      const ar = await createAccount('1100', 'asset');
      const revenue = await createAccount('4100', 'revenue');
      const tax = await createAccount('2100', 'liability');
      const component = await (
        await TaxComponentCollection.create({ db })
      ).create({
        tenantId,
        name: 'GST',
        percent: '5',
        liabilityAccountId: tax.id,
      });
      const code = await (await TaxCodeCollection.create({ db })).create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: component.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const setting = await settings.getOrCreateForTenant(tenantId);
      setting.defaultSalesTaxCodeId = code.id;
      await setting.save();
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: code.id,
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'PG-POST',
        currency: 'CAD',
      });
      await (await InvoiceLineItemCollection.create({ db })).create({
        invoiceId: invoice.id,
        description: 'Stored line',
        quantity: 1,
        unitPrice: 10_000,
        taxMode: 'override',
        taxCodeId: code.id,
        revenueAccountId: revenue.id,
      });
      const ready = await invoices.get({ id: invoice.id }, { cache: false });
      if (!ready) throw new Error('Expected invoice ready to issue');
      ready.status = InvoiceStatus.SENT;
      await ready.save();

      const [left, right] = await Promise.all([
        invoices.get({ id: invoice.id }, { cache: false }),
        invoices.get({ id: invoice.id }, { cache: false }),
      ]);
      if (!left || !right) throw new Error('Expected persisted invoice');
      const recognize = (candidate: typeof invoice) =>
        candidate.recognizeRevenue({
          arAccountId: ar.id,
          revenueAccountId: revenue.id,
          taxAccountId: tax.id,
          bookCurrency: 'CAD',
        });
      const [first, retry] = await Promise.all([
        recognize(left),
        recognize(right),
      ]);
      expect(retry.id).toBe(first.id);
      expect(
        await (await JournalCollection.create({ db })).list({
          where: { sourceModule: 'smrt-commerce' },
        }),
      ).toHaveLength(1);

      const posted = await invoices.get({ id: invoice.id }, { cache: false });
      if (!posted) throw new Error('Expected posted invoice');
      const reversal = await posted.cancelWithRevenueReversal({
        bookCurrency: 'CAD',
      });
      const reversalRetry = await posted.cancelWithRevenueReversal({
        bookCurrency: 'CAD',
      });
      expect(reversalRetry?.id).toBe(reversal?.id);
      expect(
        await (await JournalCollection.create({ db })).list({
          where: { sourceModule: 'smrt-commerce' },
        }),
      ).toHaveLength(2);
    });
  });
});
