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
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import {
  migrateCommerceLineAmounts,
  rollbackCommerceLineAmounts,
} from '../migrations/commerceLineAmounts.js';
import { InvoiceStatus } from '../types/index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('commerce line amount migration on PostgreSQL (#3933)', () => {
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
    await db?.close?.();
  });

  it('persists journal ownership and exact rollback on the managed adapter', async () => {
    const tenantId = randomUUID();
    const { invoice, line } = await withTenant({ tenantId }, async () => {
      const invoice = await (await InvoiceCollection.create({ db })).create({
        tenantId,
        invoiceNumber: 'PG-MIGRATION',
        status: InvoiceStatus.SENT,
        subtotal: 4_500,
        taxAmount: 225,
        totalAmount: 4_725,
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        tenantId,
        invoiceId: invoice.id,
        description: 'PostgreSQL line',
        quantity: 1,
        unitPrice: 4_500,
        taxRate: 0.05,
      });
      return { invoice, line };
    });
    const before = (
      await db.query('SELECT * FROM invoice_line_items WHERE id = ?', line.id)
    ).rows[0];
    await withTenant({ tenantId }, async () => {
      const settings = await (
        await TaxSettingsCollection.create({ db })
      ).getOrCreateForTenant(tenantId);
      settings.defaultLineAmountType = 'inclusive';
      settings.taxRoundingScope = 'document';
      await settings.save();
    });
    const result = await migrateCommerceLineAmounts(db, { tenantId });
    expect(result.activated).toBe(true);
    expect(
      (await db.query('SELECT * FROM invoices WHERE id = ?', invoice.id))
        .rows[0],
    ).toMatchObject({
      line_amount_type: 'exclusive',
      tax_rounding_scope: 'line',
    });
    expect(
      (
        await db.query(
          'SELECT state FROM commerce_money_migration_documents WHERE document_id = ?',
          invoice.id,
        )
      ).rows[0],
    ).toMatchObject({ state: 'applied' });
    await rollbackCommerceLineAmounts(db, {
      tenantId,
      migrationId: result.migrationId,
    });
    expect(
      (await db.query('SELECT * FROM invoice_line_items WHERE id = ?', line.id))
        .rows[0],
    ).toEqual(before);
  });

  it('rolls back a refused checksum preflight to the active v2 marker', async () => {
    const tenantId = randomUUID();
    const { invoice, line } = await withTenant({ tenantId }, async () => {
      const invoice = await (await InvoiceCollection.create({ db })).create({
        tenantId,
        invoiceNumber: 'PG-ROLLBACK-REFUSAL',
        status: InvoiceStatus.SENT,
        subtotal: 1_000,
        taxAmount: 50,
        totalAmount: 1_050,
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        tenantId,
        invoiceId: invoice.id,
        description: 'Original PostgreSQL line',
        quantity: 1,
        unitPrice: 1_000,
        taxRate: 0.05,
      });
      return { invoice, line };
    });
    const result = await migrateCommerceLineAmounts(db, { tenantId });
    await db.query(
      'UPDATE invoice_line_items SET description = ? WHERE id = ?',
      'Later PostgreSQL change',
      line.id,
    );
    await expect(
      rollbackCommerceLineAmounts(db, {
        tenantId,
        migrationId: result.migrationId,
      }),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
    await withTenant({ tenantId }, async () => {
      expect(
        await (await TaxSettingsCollection.create({ db })).getForTenant(
          tenantId,
        ),
      ).toMatchObject({ moneyModel: 'v2', moneyMigrationId: '' });
      await expect(
        (await InvoiceCollection.create({ db })).get({ id: invoice.id }),
      ).resolves.toBeTruthy();
    });
  });

  it('keeps exempt and ordinary zero-rate documents distinct', async () => {
    const tenantId = randomUUID();
    const { draftLine, issued, issuedLine } = await withTenant(
      { tenantId },
      async () => {
        const customers = await CustomerCollection.create({ db });
        const invoices = await InvoiceCollection.create({ db });
        const lines = await InvoiceLineItemCollection.create({ db });
        const ordinary = await customers.create({ profileId: randomUUID() });
        const exempt = await customers.create({
          profileId: randomUUID(),
          taxExempt: true,
        });
        const draft = await invoices.create({
          tenantId,
          invoiceNumber: 'PG-ZERO-DRAFT',
          customerId: ordinary.id,
          status: InvoiceStatus.DRAFT,
          currency: 'CAD',
        });
        const draftLine = await lines.create({
          tenantId,
          invoiceId: draft.id,
          description: 'Ordinary zero-rate draft',
          quantity: 1,
          unitPrice: 2_000,
          taxRate: 0,
        });
        const issued = await invoices.create({
          tenantId,
          invoiceNumber: 'PG-ZERO-ISSUED',
          customerId: exempt.id,
          status: InvoiceStatus.SENT,
          subtotal: 1_000,
          taxAmount: 0,
          totalAmount: 1_000,
          currency: 'CAD',
        });
        const issuedLine = await lines.create({
          tenantId,
          invoiceId: issued.id,
          description: 'Exempt zero-rate issued invoice',
          quantity: 1,
          unitPrice: 1_000,
          taxRate: 0,
          amount: 1_000,
        });
        return { draftLine, issued, issuedLine };
      },
    );

    await migrateCommerceLineAmounts(db, {
      tenantId,
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
});
