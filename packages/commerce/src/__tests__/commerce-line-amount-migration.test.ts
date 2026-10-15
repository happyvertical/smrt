import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractLineItemCollection } from '../collections/ContractLineItemCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { VendorCollection } from '../collections/VendorCollection.js';
import {
  migrateCommerceLineAmounts,
  preflightCommerceLineAmounts,
  rollbackCommerceLineAmounts,
} from '../migrations/commerceLineAmounts.js';
import { Order, SupplierQuote } from '../models/Contract.js';
import { MoneyMigrationDocument } from '../models/MoneyMigrationDocument.js';
import { ContractStatus, InvoiceStatus } from '../types/index.js';

const TENANT = '00000000-0000-4000-8000-000000000393';

describe('commerce line amount migration (#3933)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function issued(amount = 10_500) {
    return withTenant({ tenantId: TENANT }, async () => {
      const invoice = await (await InvoiceCollection.create({ db })).create({
        tenantId: TENANT,
        invoiceNumber: `M-${amount}`,
        status: InvoiceStatus.SENT,
        subtotal: 10_000,
        taxAmount: 500,
        totalAmount: 10_500,
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        tenantId: TENANT,
        invoiceId: invoice.id,
        description: 'Legacy taxable service',
        quantity: 1,
        unitPrice: 10_000,
        taxRate: 0.05,
        amount,
      });
      if (amount !== 10_500)
        await db.query(
          'UPDATE invoice_line_items SET amount = ? WHERE id = ?',
          amount,
          line.id,
        );
      return { invoice, line };
    });
  }

  async function setNonLegacyDefaults(tenantId = TENANT) {
    await withTenant({ tenantId }, async () => {
      const settings = await (
        await TaxSettingsCollection.create({ db })
      ).getOrCreateForTenant(tenantId);
      settings.defaultLineAmountType = 'inclusive';
      settings.taxRoundingScope = 'document';
      await settings.save();
    });
  }

  it('journals, migrates, verifies, and exactly rolls back an issued invoice', async () => {
    const { invoice, line } = await issued();
    await setNonLegacyDefaults();
    const beforeHeader = (
      await db.query('SELECT * FROM invoices WHERE id = ?', invoice.id)
    ).rows[0];
    const beforeLine = (
      await db.query('SELECT * FROM invoice_line_items WHERE id = ?', line.id)
    ).rows[0];

    const result = await migrateCommerceLineAmounts(db, { tenantId: TENANT });
    expect(result).toMatchObject({ migrated: 1, activated: true });
    const migratedLine = (
      await db.query('SELECT * FROM invoice_line_items WHERE id = ?', line.id)
    ).rows[0];
    expect(migratedLine).toMatchObject({
      amount: 10_000,
      tax_amount: 500,
      legacy_amount: 10_500,
    });
    const afterHeader = (
      await db.query('SELECT * FROM invoices WHERE id = ?', invoice.id)
    ).rows[0];
    expect(afterHeader).toMatchObject({
      line_amount_type: 'exclusive',
      tax_rounding_scope: 'line',
    });
    for (const key of Object.keys(beforeHeader).filter(
      (key) =>
        ![
          'discount_total',
          'line_amount_type',
          'tax_rounding_scope',
          'seller_tax_registrations_json',
          'party_tax_id',
          'money_snapshot_id',
        ].includes(key),
    ))
      expect(afterHeader[key]).toEqual(beforeHeader[key]);

    await rollbackCommerceLineAmounts(db, {
      tenantId: TENANT,
      migrationId: result.migrationId,
    });
    expect(
      (await db.query('SELECT * FROM invoices WHERE id = ?', invoice.id))
        .rows[0],
    ).toEqual(beforeHeader);
    expect(
      (await db.query('SELECT * FROM invoice_line_items WHERE id = ?', line.id))
        .rows[0],
    ).toEqual(beforeLine);
    await withTenant({ tenantId: TENANT }, async () => {
      const settings = await (
        await TaxSettingsCollection.create({ db })
      ).getForTenant(TENANT);
      expect(settings?.moneyModel).toBe('legacy');
    });
  });

  it('stops on an issued unreconciled delta before claiming the tenant', async () => {
    const { line } = await issued(10_499);
    const report = await preflightCommerceLineAmounts(db, { tenantId: TENANT });
    expect(report.documents[0]).toMatchObject({
      delta: { taxMinor: -1 },
      reasons: expect.arrayContaining(['UNRECONCILED']),
    });
    await expect(
      migrateCommerceLineAmounts(db, { tenantId: TENANT }),
    ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
    expect(
      (
        await db.query(
          'SELECT amount FROM invoice_line_items WHERE id = ?',
          line.id,
        )
      ).rows[0]?.amount,
    ).toBe(10_499);
    await withTenant({ tenantId: TENANT }, async () => {
      const settings = await (
        await TaxSettingsCollection.create({ db })
      ).getForTenant(TENANT);
      expect(settings?.moneyModel).toBe('legacy');
    });
  });

  it('promotes a draft legacy rate to an explicit code before recompute', async () => {
    const { invoice, line } = await withTenant(
      { tenantId: TENANT },
      async () => {
        const invoice = await (await InvoiceCollection.create({ db })).create({
          tenantId: TENANT,
          invoiceNumber: 'M-DRAFT',
          status: InvoiceStatus.DRAFT,
          currency: 'CAD',
        });
        const line = await (
          await InvoiceLineItemCollection.create({ db })
        ).create({
          tenantId: TENANT,
          invoiceId: invoice.id,
          description: 'Draft legacy tax',
          quantity: 1,
          unitPrice: 2_000,
          taxRate: 0.05,
        });
        return { invoice, line };
      },
    );
    await expect(
      migrateCommerceLineAmounts(db, { tenantId: TENANT }),
    ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
    await migrateCommerceLineAmounts(db, {
      tenantId: TENANT,
      acceptDraftChanges: true,
    });
    expect(
      (
        await db.query(
          'SELECT amount, tax_amount, tax_mode, tax_code_id, tax_components_json FROM invoice_line_items WHERE id = ?',
          line.id,
        )
      ).rows[0],
    ).toMatchObject({
      amount: 2_000,
      tax_amount: 100,
      tax_mode: 'override',
    });
    expect(
      (
        await db.query(
          'SELECT subtotal, tax_amount, total_amount FROM invoices WHERE id = ?',
          invoice.id,
        )
      ).rows[0],
    ).toMatchObject({ subtotal: 2_000, tax_amount: 100, total_amount: 2_100 });
  });

  it('preserves each document customer classification for mixed zero-rate migration', async () => {
    const { draftLine, issued, issuedLine } = await withTenant(
      { tenantId: TENANT },
      async () => {
        const customers = await CustomerCollection.create({ db });
        const invoices = await InvoiceCollection.create({ db });
        const lines = await InvoiceLineItemCollection.create({ db });
        const ordinary = await customers.create({ profileId: 'ordinary-zero' });
        const exempt = await customers.create({
          profileId: 'exempt-zero',
          taxExempt: true,
        });
        const draft = await invoices.create({
          tenantId: TENANT,
          invoiceNumber: 'M-ZERO-DRAFT',
          customerId: ordinary.id,
          status: InvoiceStatus.DRAFT,
          currency: 'CAD',
        });
        const draftLine = await lines.create({
          tenantId: TENANT,
          invoiceId: draft.id,
          description: 'Ordinary zero-rated legacy draft',
          quantity: 1,
          unitPrice: 2_000,
          taxRate: 0,
        });
        const issued = await invoices.create({
          tenantId: TENANT,
          invoiceNumber: 'M-ZERO-ISSUED',
          customerId: exempt.id,
          status: InvoiceStatus.SENT,
          subtotal: 1_000,
          taxAmount: 0,
          totalAmount: 1_000,
          currency: 'CAD',
        });
        const issuedLine = await lines.create({
          tenantId: TENANT,
          invoiceId: issued.id,
          description: 'Exempt legacy issued invoice',
          quantity: 1,
          unitPrice: 1_000,
          taxRate: 0,
          amount: 1_000,
        });
        return { draftLine, issued, issuedLine };
      },
    );

    await migrateCommerceLineAmounts(db, {
      tenantId: TENANT,
      acceptDraftChanges: true,
    });
    const codeFor = async (lineId: string) =>
      (
        await db.query(
          `SELECT tax_codes.code
             FROM invoice_line_items
             JOIN tax_codes ON tax_codes.id = invoice_line_items.tax_code_id
            WHERE invoice_line_items.id = ?`,
          lineId,
        )
      ).rows[0]?.code;
    if (!draftLine.id || !issuedLine.id)
      throw new Error('Expected saved zero-rate migration lines');
    await expect(codeFor(draftLine.id)).resolves.toBe('out-of-scope');
    await expect(codeFor(issuedLine.id)).resolves.toBe('exempt');
    expect(
      (
        await db.query(
          'SELECT kind FROM document_taxes WHERE document_type = ? AND document_id = ?',
          'invoice',
          issued.id,
        )
      ).rows,
    ).toEqual([{ kind: 'exempt' }]);
  });

  it('reports a cross-tenant line and leaves both tenants unchanged', async () => {
    const { line } = await issued();
    await db.query(
      'UPDATE invoice_line_items SET tenant_id = ? WHERE id = ?',
      'tenant-foreign',
      line.id,
    );
    const report = await preflightCommerceLineAmounts(db, { tenantId: TENANT });
    expect(report.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasons: expect.arrayContaining(['CROSS_TENANT_LINE']),
        }),
      ]),
    );
    await expect(
      migrateCommerceLineAmounts(db, { tenantId: TENANT }),
    ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
    expect(
      (
        await db.query(
          'SELECT tenant_id, amount FROM invoice_line_items WHERE id = ?',
          line.id,
        )
      ).rows[0],
    ).toMatchObject({ tenant_id: 'tenant-foreign', amount: 10_500 });
  });

  it('migrates a directed issued sales Contract without rewriting prior header fields', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000394';
    const { contract, line } = await withTenant({ tenantId }, async () => {
      const customer = await (await CustomerCollection.create({ db })).create({
        tenantId,
        name: 'Migration customer',
      });
      const contract = new Order({
        db,
        tenantId,
        customerId: customer.id,
        status: ContractStatus.SENT,
        subtotal: 3_000,
        taxAmount: 150,
        totalAmount: 3_150,
        currency: 'CAD',
      });
      await contract.initialize();
      await contract.save();
      const line = await (
        await ContractLineItemCollection.create({ db })
      ).create({
        tenantId,
        contractId: contract.id,
        description: 'Legacy order line',
        quantity: 1,
        unitPrice: 3_000,
        taxRate: 0.05,
      });
      return { contract, line };
    });
    const beforeHeader = (
      await db.query('SELECT * FROM contracts WHERE id = ?', contract.id)
    ).rows[0];
    await setNonLegacyDefaults(tenantId);
    await migrateCommerceLineAmounts(db, { tenantId });
    expect(
      (
        await db.query(
          'SELECT amount, tax_amount, legacy_amount FROM contract_line_items WHERE id = ?',
          line.id,
        )
      ).rows[0],
    ).toMatchObject({ amount: 3_000, tax_amount: 150, legacy_amount: 3_150 });
    const afterHeader = (
      await db.query('SELECT * FROM contracts WHERE id = ?', contract.id)
    ).rows[0];
    expect(afterHeader).toMatchObject({
      line_amount_type: 'exclusive',
      tax_rounding_scope: 'line',
    });
    expect(afterHeader.updated_at).toEqual(beforeHeader.updated_at);
    expect(afterHeader.total_amount).toBe(beforeHeader.total_amount);
  });

  it('migrates an issued supplier quote as purchases and exactly rolls it back', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000417';
    const { contract, line } = await withTenant({ tenantId }, async () => {
      const vendor = await (await VendorCollection.create({ db })).create({
        tenantId,
        name: 'Migration vendor',
      });
      const contract = new SupplierQuote({
        db,
        tenantId,
        vendorId: vendor.id,
        status: ContractStatus.SENT,
        subtotal: 3_000,
        taxAmount: 150,
        totalAmount: 3_150,
        currency: 'CAD',
      });
      await contract.initialize();
      await contract.save();
      const line = await (
        await ContractLineItemCollection.create({ db })
      ).create({
        tenantId,
        contractId: contract.id,
        description: 'Legacy order line',
        quantity: 1,
        unitPrice: 3_000,
        taxRate: 0.05,
      });
      return { contract, line };
    });
    const beforeHeader = (
      await db.query('SELECT * FROM contracts WHERE id = ?', contract.id)
    ).rows[0];
    await setNonLegacyDefaults(tenantId);
    const migration = await migrateCommerceLineAmounts(db, { tenantId });
    expect(migration.activated).toBe(true);
    expect(
      (
        await db.query(
          'SELECT amount, tax_amount, legacy_amount FROM contract_line_items WHERE id = ?',
          line.id,
        )
      ).rows[0],
    ).toMatchObject({ amount: 3_000, tax_amount: 150, legacy_amount: 3_150 });
    const afterHeader = (
      await db.query('SELECT * FROM contracts WHERE id = ?', contract.id)
    ).rows[0];
    expect(afterHeader).toMatchObject({
      line_amount_type: 'exclusive',
      tax_rounding_scope: 'line',
    });
    expect(afterHeader.updated_at).toEqual(beforeHeader.updated_at);
    expect(afterHeader.total_amount).toBe(beforeHeader.total_amount);
    expect(afterHeader._meta_type).toBe(
      '@happyvertical/smrt-commerce:SupplierQuote',
    );
    expect(afterHeader.money_snapshot_id).toBeTruthy();
    await rollbackCommerceLineAmounts(db, {
      tenantId,
      migrationId: migration.migrationId,
    });
    expect(
      (await db.query('SELECT * FROM contracts WHERE id = ?', contract.id))
        .rows[0],
    ).toEqual(beforeHeader);
  });

  it('refuses rollback after any post-image change', async () => {
    const { line } = await issued();
    const result = await migrateCommerceLineAmounts(db, { tenantId: TENANT });
    await db.query(
      'UPDATE invoice_line_items SET description = ? WHERE id = ?',
      'Changed later',
      line.id,
    );
    await expect(
      rollbackCommerceLineAmounts(db, {
        tenantId: TENANT,
        migrationId: result.migrationId,
      }),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
    expect(
      (
        await db.query(
          'SELECT description FROM invoice_line_items WHERE id = ?',
          line.id,
        )
      ).rows[0]?.description,
    ).toBe('Changed later');
    await withTenant({ tenantId: TENANT }, async () => {
      const settings = await (
        await TaxSettingsCollection.create({ db })
      ).getForTenant(TENANT);
      expect(settings).toMatchObject({
        moneyModel: 'v2',
        moneyMigrationId: '',
      });
      await expect(
        (await InvoiceCollection.create({ db })).get({ id: line.invoiceId }),
      ).resolves.toBeTruthy();
    });
  });

  it('refuses rollback when a document was created under v2', async () => {
    const { line } = await issued();
    await setNonLegacyDefaults();
    const result = await migrateCommerceLineAmounts(db, { tenantId: TENANT });
    const taxCodeId = (
      await db.query(
        'SELECT tax_code_id FROM invoice_line_items WHERE id = ?',
        line.id,
      )
    ).rows[0]?.tax_code_id;
    const invoiceId = await withTenant({ tenantId: TENANT }, async () => {
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        tenantId: TENANT,
        invoiceNumber: 'V2-AFTER',
        currency: 'CAD',
      });
      await (await InvoiceLineItemCollection.create({ db })).create({
        tenantId: TENANT,
        invoiceId: invoice.id,
        description: 'Inclusive v2 service',
        quantity: 1,
        unitPrice: 10_500,
        taxMode: 'override',
        taxCodeId,
      });
      const draft = await invoices.get({ id: invoice.id });
      if (!draft) throw new Error('v2 invoice missing');
      draft.status = InvoiceStatus.SENT;
      await draft.save();
      return String(invoice.id);
    });
    const issuedTotals =
      'SELECT subtotal, tax_amount, total_amount FROM invoices WHERE id = ?';
    const before = (await db.query(issuedTotals, invoiceId)).rows[0];
    expect(before).toMatchObject({ subtotal: 10_000, total_amount: 10_500 });

    // Restoring legacy would let an ordinary lifecycle save reprice this
    // inclusive issued invoice as exclusive (10,500 -> 11,025).
    await expect(
      rollbackCommerceLineAmounts(db, {
        tenantId: TENANT,
        migrationId: result.migrationId,
      }),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
    await withTenant({ tenantId: TENANT }, async () => {
      const settings = await (
        await TaxSettingsCollection.create({ db })
      ).getForTenant(TENANT);
      expect(settings).toMatchObject({
        moneyModel: 'v2',
        moneyMigrationId: '',
      });
      const invoice = await (await InvoiceCollection.create({ db })).get({
        id: invoiceId,
      });
      if (!invoice) throw new Error('v2 invoice missing');
      invoice.status = InvoiceStatus.VIEWED;
      await invoice.save();
    });
    expect((await db.query(issuedTotals, invoiceId)).rows[0]).toEqual(before);
  });

  it('leaves v2 runtime available when a rollback owner has no journal', async () => {
    const { invoice } = await issued();
    await migrateCommerceLineAmounts(db, { tenantId: TENANT });
    await expect(
      rollbackCommerceLineAmounts(db, {
        tenantId: TENANT,
        migrationId: '00000000-0000-4000-8000-000000003934',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
    await withTenant({ tenantId: TENANT }, async () => {
      const settings = await (
        await TaxSettingsCollection.create({ db })
      ).getForTenant(TENANT);
      expect(settings).toMatchObject({
        moneyModel: 'v2',
        moneyMigrationId: '',
      });
      await expect(
        (await InvoiceCollection.create({ db })).get({ id: invoice.id }),
      ).resolves.toBeTruthy();
    });
  });

  it('resumes a partial rollback with the same owner', async () => {
    const first = await issued();
    const second = await withTenant({ tenantId: TENANT }, async () => {
      const invoice = await (await InvoiceCollection.create({ db })).create({
        tenantId: TENANT,
        invoiceNumber: 'M-SECOND',
        status: InvoiceStatus.SENT,
        subtotal: 2_000,
        taxAmount: 100,
        totalAmount: 2_100,
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        tenantId: TENANT,
        invoiceId: invoice.id,
        description: 'Second legacy service',
        quantity: 1,
        unitPrice: 2_000,
        taxRate: 0.05,
      });
      return { invoice, line };
    });
    const result = await migrateCommerceLineAmounts(db, { tenantId: TENANT });
    const originalSave = MoneyMigrationDocument.prototype.save;
    let restoredSaves = 0;
    const save = vi
      .spyOn(MoneyMigrationDocument.prototype, 'save')
      .mockImplementation(async function (...args) {
        if (this.state === 'rolled_back' && restoredSaves++ === 1)
          throw new Error('interrupted after first restore');
        return originalSave.apply(this, args);
      });
    await expect(
      rollbackCommerceLineAmounts(db, {
        tenantId: TENANT,
        migrationId: result.migrationId,
      }),
    ).rejects.toThrow('interrupted after first restore');
    save.mockRestore();
    await withTenant({ tenantId: TENANT }, async () => {
      expect(
        await (await TaxSettingsCollection.create({ db })).getForTenant(TENANT),
      ).toMatchObject({
        moneyModel: 'migrating',
        moneyMigrationId: result.migrationId,
      });
    });
    await expect(
      rollbackCommerceLineAmounts(db, {
        tenantId: TENANT,
        migrationId: '00000000-0000-4000-8000-000000003935',
      }),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
    const resumed = await rollbackCommerceLineAmounts(db, {
      tenantId: TENANT,
      migrationId: result.migrationId,
    });
    expect(resumed).toMatchObject({ restored: 1, alreadyRestored: 1 });
    expect(
      (
        await db.query(
          'SELECT legacy_amount FROM invoice_line_items WHERE id IN (?, ?) ORDER BY id',
          [first.line.id, second.line.id],
        )
      ).rows,
    ).toEqual([{ legacy_amount: null }, { legacy_amount: null }]);
  });

  it('resumes exact applied journals after activation is interrupted', async () => {
    const { line } = await issued();
    const migrationId = '00000000-0000-4000-8000-000000003933';
    const activation = vi
      .spyOn(TaxSettingsCollection.prototype, 'activateMoneyV2')
      .mockRejectedValueOnce(new Error('interrupted before activation'));
    await expect(
      migrateCommerceLineAmounts(db, {
        tenantId: TENANT,
        migrationId,
      }),
    ).rejects.toThrow('interrupted before activation');
    expect(
      await withTenant(
        { tenantId: TENANT },
        async () =>
          (
            await (
              await TaxSettingsCollection.create({ db })
            ).getForTenant(TENANT)
          )?.moneyMigrationId,
      ),
    ).toBe(migrationId);
    await expect(
      migrateCommerceLineAmounts(db, {
        tenantId: TENANT,
        migrationId: '00000000-0000-4000-8000-000000003934',
      }),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
    activation.mockRestore();
    const resumed = await migrateCommerceLineAmounts(db, {
      tenantId: TENANT,
      migrationId,
    });
    expect(resumed).toMatchObject({ migrated: 0, resumed: 1, activated: true });
    expect(
      (
        await db.query(
          'SELECT legacy_amount, amount FROM invoice_line_items WHERE id = ?',
          line.id,
        )
      ).rows[0],
    ).toMatchObject({ legacy_amount: 10_500, amount: 10_000 });
  });
});
