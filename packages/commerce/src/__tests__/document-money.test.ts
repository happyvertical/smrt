import {
  getTestDatabase,
  MCPGenerator,
  ObjectRegistry,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { ProductCollection } from '@happyvertical/smrt-products/collections';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection';
import { InvoiceCollection } from '../collections/InvoiceCollection';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection';
import { PaymentCollection } from '../collections/PaymentCollection';
import { TaxCodeCollection } from '../collections/TaxCodeCollection';
import { TaxComponentCollection } from '../collections/TaxComponentCollection';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection';
import { previewInvoiceMoney } from '../document-money';
import { serializeInvoiceMcpGet } from '../invoice-mcp';
import { DocumentTax } from '../models/DocumentTax';
import { Invoice } from '../models/Invoice';
import { InvoiceLineItem } from '../models/InvoiceLineItem';
import { MoneyValidationError } from '../money';
import { ensureTenantTaxCodes } from '../tax/legacy';
import { InvoiceStatus } from '../types';
import { seedLegacyMoneyTenant } from './helpers/legacy-money-tenant';

function gateFieldForTest(
  objectClass: typeof SmrtObject,
  fieldName: string,
  permission: string,
): () => void {
  const registered = ObjectRegistry.getClassByConstructor(objectClass);
  if (!registered) throw new Error(`Expected ${objectClass.name} registration`);
  const definitions = [registered.fields, registered.inheritedFields]
    .filter((fields) => fields !== undefined)
    .map((fields) => fields.get(fieldName))
    .filter((field) => field !== undefined);
  if (definitions.length === 0)
    throw new Error(`Expected ${objectClass.name}.${fieldName} registration`);
  const prior = definitions.map((field) => field.readPermission);
  definitions.forEach((field) => {
    field.readPermission = permission;
  });
  return () => {
    definitions.forEach((field, index) => {
      if (prior[index] === undefined) delete field.readPermission;
      else field.readPermission = prior[index];
    });
  };
}

describe('invoice money persistence (#3933)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function activateV2(tenantId: string): Promise<string> {
    await ensureTenantTaxCodes(db, tenantId);
    return withTenant({ tenantId }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const gst = await components.create({ name: 'GST', percent: '5' });
      const codes = await TaxCodeCollection.create({ db });
      const code = await codes.create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: gst.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const current = await settings.getOrCreateForTenant(tenantId);
      current.defaultSalesTaxCodeId = code.id;
      current.defaultLineAmountType = 'exclusive';
      current.taxRoundingScope = 'document';
      current.taxRegistrations = [
        { taxComponentId: gst.id, number: 'GST-123', label: 'GST' },
      ];
      await current.save();
      // A clean tenant starts on money v2 (#4009); no migration needed.
      if ((await settings.getOrCreateForTenant(tenantId)).moneyModel !== 'v2')
        throw new Error('Expected a clean tenant on money v2');
      expect(await settings.getForTenant(tenantId)).toMatchObject({
        moneyModel: 'v2',
        taxRoundingScope: 'document',
      });
      return code.id;
    });
  }

  it('recomputes one aggregate atomically and freezes a stable issued snapshot', async () => {
    const taxCodeId = await activateV2('tenant-a');
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({
        defaultTaxCodeId: taxCodeId,
        taxId: 'CUSTOMER-TAX',
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'INV-V2',
        currency: 'CAD',
      });
      expect(invoice).toMatchObject({
        lineAmountType: 'exclusive',
        taxRoundingScope: 'document',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      const line = await lines.create({
        invoiceId: invoice.id,
        description: 'Service',
        quantity: 1,
        unitPrice: 100,
        discountType: 'amount',
        discount: 10,
        taxMode: 'override',
        taxCodeId,
        revenueAccountId: 'revenue',
      });
      expect(line).toMatchObject({ amount: 90, taxAmount: 5, taxRate: 0.05 });
      expect(line.taxComponents).toMatchObject([
        { name: 'GST', percent: '5', taxMinor: 5 },
      ]);
      const storedInvoice = await invoices.get(
        { id: invoice.id },
        { cache: false },
      );
      expect(storedInvoice).toMatchObject({
        subtotal: 90,
        discountTotal: 10,
        taxAmount: 5,
        totalAmount: 95,
      });
      const taxes = await DocumentTaxCollection.create({ db });
      const before = await taxes.findByDocument(
        'tenant-a',
        'invoice',
        invoice.id,
      );
      expect(before).toMatchObject([
        { taxableMinor: 90, taxMinor: 5, taxCodeId },
      ]);

      line.taxAmount = 999;
      await line.save();
      expect(line.taxAmount).toBe(5);
      const after = await taxes.findByDocument(
        'tenant-a',
        'invoice',
        invoice.id,
      );
      expect(after.map((row) => row.updated_at)).toEqual(
        before.map((row) => row.updated_at),
      );

      if (!storedInvoice) throw new Error('Expected invoice');
      storedInvoice.status = InvoiceStatus.SENT;
      storedInvoice.sentAt = new Date('2026-10-13T12:00:00.000Z');
      await storedInvoice.save();
      expect(storedInvoice.moneySnapshotId).not.toBe('');
      expect(storedInvoice.partyTaxId).toBe('CUSTOMER-TAX');
      expect(storedInvoice.sellerTaxRegistrations).toHaveLength(1);
      expect(line.moneySnapshotId).toBe('');
      const issuedLine = await lines.get({ id: line.id }, { cache: false });
      expect(issuedLine?.moneySnapshotId).toBe(storedInvoice.moneySnapshotId);

      if (!issuedLine) throw new Error('Expected issued line');
      issuedLine.description = 'Forged';
      await expect(issuedLine.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      await expect(issuedLine.delete()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      storedInvoice.status = InvoiceStatus.VIEWED;
      storedInvoice.viewedAt = new Date('2026-10-13T13:00:00.000Z');
      const snapshotId = storedInvoice.moneySnapshotId;
      await storedInvoice.save();
      expect(storedInvoice.moneySnapshotId).toBe(snapshotId);
      storedInvoice.arJournalId = 'journal-issued';
      await storedInvoice.save();
      storedInvoice.arJournalId = '';
      await expect(storedInvoice.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      storedInvoice.arJournalId = 'journal-issued';
      storedInvoice.currency = 'USD';
      await expect(storedInvoice.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);

      const mcp = await new MCPGenerator(
        { classNames: ['@happyvertical/smrt-commerce:Invoice'] },
        {
          db,
          user: { id: 'invoice-reader' },
          tenantId: 'tenant-a',
        },
      ).handleToolCall({
        method: 'tools/call',
        params: { name: 'invoice_get', arguments: { id: invoice.id } },
      });
      expect(mcp.isError).not.toBe(true);
      expect(mcp.structuredContent).toMatchObject({
        id: invoice.id,
        money: {
          source: 'stored',
          moneySnapshotId: snapshotId,
          header: {
            subtotalMinor: 90,
            taxAmountMinor: 5,
            totalAmountMinor: 95,
          },
          lines: [expect.objectContaining({ amountMinor: 90, taxMinor: 5 })],
          taxes: [expect.objectContaining({ taxableMinor: 90, taxMinor: 5 })],
        },
      });

      const restorePolicies = [
        gateFieldForTest(Invoice, 'taxAmount', 'invoices.read.money'),
        gateFieldForTest(InvoiceLineItem, 'taxAmount', 'invoices.read.money'),
        gateFieldForTest(DocumentTax, 'taxMinor', 'invoices.read.money'),
      ];
      try {
        const denied = await serializeInvoiceMcpGet(storedInvoice);
        expect(denied).not.toHaveProperty('taxAmount');
        expect(denied).not.toHaveProperty('money');

        const authorized = await serializeInvoiceMcpGet(storedInvoice, {
          permissions: ['invoices.read.money'],
        });
        expect(authorized).toMatchObject({
          taxAmount: 5,
          money: {
            header: { taxAmountMinor: 5 },
            lines: [expect.objectContaining({ taxMinor: 5 })],
            taxes: [expect.objectContaining({ taxMinor: 5 })],
          },
        });
      } finally {
        restorePolicies.reverse().forEach((restore) => {
          restore();
        });
      }

      const crossTenant = await withTenant({ tenantId: 'tenant-other' }, () =>
        new MCPGenerator(
          { classNames: ['@happyvertical/smrt-commerce:Invoice'] },
          {
            db,
            user: { id: 'other-reader' },
            tenantId: 'tenant-other',
          },
        ).handleToolCall({
          method: 'tools/call',
          params: { name: 'invoice_get', arguments: { id: invoice.id } },
        }),
      );
      expect(crossTenant.isError).toBe(true);
    });
  });

  it('retains an issued freeze after an undelivered paid invoice returns to draft', async () => {
    const taxCodeId = await activateV2('tenant-payment-freeze');
    await withTenant({ tenantId: 'tenant-payment-freeze' }, async () => {
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: taxCodeId,
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'PAYMENT-FREEZE',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      const line = await lines.create({
        invoiceId: invoice.id,
        description: 'Undelivered taxable line',
        quantity: 1,
        unitPrice: 20,
      });
      const payment = await (await PaymentCollection.create({ db })).create({
        customerId: customer.id,
        currency: 'CAD',
        amount: 21,
      });
      const allocations = await PaymentAllocationCollection.create({ db });
      const allocationId = crypto.randomUUID();
      await allocations.allocatePayment({
        paymentId: payment.id,
        allocations: [{ id: allocationId, invoiceId: invoice.id, amount: 21 }],
      });
      const paid = await invoices.get({ id: invoice.id }, { cache: false });
      expect(paid).toMatchObject({ status: InvoiceStatus.PAID });
      expect(paid?.moneySnapshotId).not.toBe('');
      const snapshotId = paid?.moneySnapshotId;

      await allocations.removeAllocation(allocationId);
      const reverted = await invoices.get({ id: invoice.id }, { cache: false });
      expect(reverted).toMatchObject({
        status: InvoiceStatus.DRAFT,
        moneySnapshotId: snapshotId,
      });
      await expect(
        previewInvoiceMoney({
          db,
          invoiceId: invoice.id,
          tenantId: 'tenant-payment-freeze',
        }),
      ).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      if (!reverted) throw new Error('Expected reverted invoice');
      reverted.currency = 'USD';
      await expect(reverted.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      const persistedLine = await lines.get({ id: line.id }, { cache: false });
      if (!persistedLine) throw new Error('Expected frozen line');
      persistedLine.unitPrice = 30;
      await expect(persistedLine.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      await expect(persistedLine.delete()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
    });
  });

  it('retries the same invoice and line instances after transaction failures', async () => {
    const taxCodeId = await activateV2('tenant-retry');
    await withTenant({ tenantId: 'tenant-retry' }, async () => {
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: taxCodeId,
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'RETRY',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      const line = await lines.create({
        invoiceId: invoice.id,
        description: 'Retry line',
        quantity: 1,
        unitPrice: 20,
      });
      await invoice.loadFromId();

      await expect(
        invoice.withTransaction(async (bound) => {
          bound.status = InvoiceStatus.SENT;
          await bound.save();
          throw new Error('outer issue aborted');
        }),
      ).rejects.toThrow('outer issue aborted');
      expect(
        await invoices.get({ id: invoice.id }, { cache: false }),
      ).toMatchObject({ status: InvoiceStatus.DRAFT, moneySnapshotId: '' });
      await invoice.save();
      expect(invoice).toMatchObject({ status: InvoiceStatus.SENT });
      expect(invoice.moneySnapshotId).not.toBe('');

      // A separate draft proves the aggregate can retry the same line object
      // after a downstream header write completed in memory but rolled back.
      const draft = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'RETRY-LINE',
        currency: 'CAD',
      });
      const retryingLine = await lines.create({
        invoiceId: draft.id,
        description: 'Retry after header failure',
        quantity: 1,
        unitPrice: 20,
      });
      retryingLine.unitPrice = 40;
      const saveDerived = Invoice.prototype.saveDerived;
      const injected = vi
        .spyOn(Invoice.prototype, 'saveDerived')
        .mockImplementationOnce(async function (...args) {
          await saveDerived.apply(this, args);
          throw new Error('injected header completion failure');
        });
      await expect(retryingLine.save()).rejects.toThrow(
        'injected header completion failure',
      );
      injected.mockRestore();
      expect(
        await invoices.get({ id: draft.id }, { cache: false }),
      ).toMatchObject({ subtotal: 20, taxAmount: 1, totalAmount: 21 });
      await retryingLine.save();
      expect(
        await invoices.get({ id: draft.id }, { cache: false }),
      ).toMatchObject({ subtotal: 40, taxAmount: 2, totalAmount: 42 });
    });
  });

  it('rejects a stale sibling without overwriting recalculated allocations', async () => {
    const taxCodeId = await activateV2('tenant-stale-sibling');
    await withTenant({ tenantId: 'tenant-stale-sibling' }, async () => {
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: taxCodeId,
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'STALE-SIBLING',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      const first = await lines.create({
        invoiceId: invoice.id,
        description: 'First',
        quantity: 1,
        unitPrice: 10,
      });
      await lines.create({
        invoiceId: invoice.id,
        description: 'Second',
        quantity: 1,
        unitPrice: 10,
      });
      const held = await lines.get({ id: first.id }, { cache: false });
      const current = await lines.get({ id: first.id }, { cache: false });
      if (!held || !current) throw new Error('Expected sibling instances');
      current.unitPrice = 40;
      await current.save();
      held.unitPrice = 50;
      await expect(held.save()).rejects.toBeDefined();
      const storedLines = await lines.findByInvoice(invoice.id);
      const stored = await invoices.get({ id: invoice.id }, { cache: false });
      expect(stored).toMatchObject({
        subtotal: 50,
        taxAmount: 3,
        totalAmount: 53,
      });
      expect(
        storedLines.reduce(
          (sum, item) => sum + item.amount + item.taxAmount,
          0,
        ),
      ).toBe(53);
    });
  });

  it('rejects invalid revenue recognition without freezing its editable draft', async () => {
    const taxCodeId = await activateV2('tenant-invalid-posting');
    await withTenant({ tenantId: 'tenant-invalid-posting' }, async () => {
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: taxCodeId,
      });
      const invoice = await (await InvoiceCollection.create({ db })).create({
        customerId: customer.id,
        invoiceNumber: 'INVALID-POSTING',
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        invoiceId: invoice.id,
        description: 'Still editable',
        quantity: 1,
        unitPrice: 20,
      });
      await expect(
        invoice.recognizeRevenue({
          arAccountId: crypto.randomUUID(),
          revenueAccountId: crypto.randomUUID(),
          bookCurrency: 'CAD',
        }),
      ).rejects.toBeDefined();
      await invoice.loadFromId();
      expect(invoice).toMatchObject({
        status: InvoiceStatus.DRAFT,
        moneySnapshotId: '',
      });
      expect(invoice.arJournalId).toBeFalsy();
      await line.loadFromId();
      line.unitPrice = 30;
      await line.save();
      await invoice.loadFromId();
      expect(invoice).toMatchObject({
        subtotal: 30,
        taxAmount: 2,
        totalAmount: 32,
      });
    });
  });

  it('resolves a product tax default ahead of customer and application defaults', async () => {
    const customerCodeId = await activateV2('tenant-product');
    await withTenant({ tenantId: 'tenant-product' }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const pst = await components.create({ name: 'PST', percent: '7' });
      const codes = await TaxCodeCollection.create({ db });
      const productCode = await codes.create({
        code: 'pst',
        name: 'PST',
        components: [{ taxComponentId: pst.id, compound: false }],
      });
      const products = await ProductCollection.create({ db });
      const product = await products.create({
        name: 'Tax-specific product',
        defaultSalesTaxCodeId: productCode.id,
      });
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({
        defaultTaxCodeId: customerCodeId,
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'INV-PRODUCT',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      const line = await lines.create({
        invoiceId: invoice.id,
        description: 'Product default',
        productId: product.id,
        quantity: 1,
        unitPrice: 100,
      });

      expect(line).toMatchObject({
        taxCodeId: productCode.id,
        taxCodeCode: 'pst',
        taxAmount: 7,
      });
    });
  });

  it('blocks runtime money writes for the persisted migration owner window', async () => {
    await seedLegacyMoneyTenant(db, 'tenant-b');
    const seeded = await ensureTenantTaxCodes(db, 'tenant-b');
    const outOfScopeId = seeded.find(
      (code) => code.code === 'out-of-scope',
    )?.id;
    if (!outOfScopeId) throw new Error('Expected out-of-scope seed');
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({
        defaultTaxCodeId: outOfScopeId,
      });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'LEGACY',
      });
      await expect(serializeInvoiceMcpGet(invoice)).resolves.not.toHaveProperty(
        'money',
      );
      const settings = await TaxSettingsCollection.create({ db });
      const migrationId = await settings.beginMoneyMigration('tenant-b');
      await expect(serializeInvoiceMcpGet(invoice)).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      const mcp = await new MCPGenerator(
        { classNames: ['@happyvertical/smrt-commerce:Invoice'] },
        {
          db,
          user: { id: 'invoice-reader' },
          tenantId: 'tenant-b',
        },
      ).handleToolCall({
        method: 'tools/call',
        params: { name: 'invoice_get', arguments: { id: invoice.id } },
      });
      expect(mcp).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: 'FROZEN_DOCUMENT' },
        },
      });
      const forged = await settings.getForTenant('tenant-b');
      if (!forged) throw new Error('Expected settings');
      forged.moneyModel = 'legacy';
      forged.moneyMigrationId = '';
      await expect(forged.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      invoice.notes = 'blocked';
      await expect(invoice.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      await settings.restoreLegacyMoneyModel('tenant-b', migrationId);
      await invoice.save();
      expect(invoice.notes).toBe('blocked');
    });
  });

  it('rolls back a failed sibling recompute and rejects line parent moves', async () => {
    const taxCodeId = await activateV2('tenant-atomic');
    await withTenant({ tenantId: 'tenant-atomic' }, async () => {
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({ defaultTaxCodeId: taxCodeId });
      const invoices = await InvoiceCollection.create({ db });
      const first = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'ATOMIC-A',
        currency: 'CAD',
      });
      const second = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'ATOMIC-B',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      const valid = await lines.create({
        invoiceId: first.id,
        description: 'Valid',
        quantity: 1,
        unitPrice: 100,
      });
      await expect(
        lines.create({
          invoiceId: first.id,
          description: 'Invalid discount',
          quantity: 1,
          unitPrice: 100,
          discountType: 'amount',
          discount: 101,
        }),
      ).rejects.toBeInstanceOf(MoneyValidationError);
      expect(await lines.findByInvoice(first.id)).toHaveLength(1);
      expect(
        await invoices.get({ id: first.id }, { cache: false }),
      ).toMatchObject({ subtotal: 100, taxAmount: 5, totalAmount: 105 });

      valid.invoiceId = second.id;
      await expect(valid.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      } satisfies Partial<MoneyValidationError>);
      expect(await lines.findByInvoice(first.id)).toHaveLength(1);
      expect(await lines.findByInvoice(second.id)).toHaveLength(0);
    });
  });
});
