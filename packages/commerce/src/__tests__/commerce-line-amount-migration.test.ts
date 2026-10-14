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
import {
  migrateCommerceLineAmounts,
  preflightCommerceLineAmounts,
  rollbackCommerceLineAmounts,
} from '../migrations/commerceLineAmounts.js';
import { Order } from '../models/Contract.js';
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

  it('journals, migrates, verifies, and exactly rolls back an issued invoice', async () => {
    const { invoice, line } = await issued();
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
    expect(afterHeader.updated_at).toEqual(beforeHeader.updated_at);
    expect(afterHeader.total_amount).toBe(beforeHeader.total_amount);
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
