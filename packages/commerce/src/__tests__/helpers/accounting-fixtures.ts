/** Shared fixtures for the accounting connection, mapping, gate and payment tests (#5136-#5139). */
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type AccountingConnectionDeps,
  type AccountingSecretStore,
  completeQuickBooksConnection,
} from '../../accounting-connection.js';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../../collections/TaxSettingsCollection.js';
import type { Invoice } from '../../models/Invoice.js';
import { ensureTenantTaxCodes } from '../../tax/standard-codes.js';
import { InvoiceStatus } from '../../types/index.js';

/** In-memory smrt-secrets stand-in. */
export class FakeSecrets implements AccountingSecretStore {
  readonly rows = new Map<string, string>();
  async storeForTenant(t: string, n: string, v: string) {
    await new Promise((r) => setTimeout(r, 1));
    this.rows.set(`${t}:${n}`, v);
  }
  async retrieveForTenant(t: string, n: string) {
    const v = this.rows.get(`${t}:${n}`);
    if (v === undefined) throw new Error('not found');
    return { value: v };
  }
  async deleteForTenant(t: string, n: string) {
    return this.rows.delete(`${t}:${n}`);
  }
}

/** Connect a tenant's QuickBooks company with fixture tokens. */
export async function connectFixtureTenant(
  db: DatabaseInterface,
  tenantId: string,
  options: {
    realmId?: string;
    environment?: 'sandbox' | 'production';
    secrets?: FakeSecrets;
  } = {},
) {
  const deps: AccountingConnectionDeps = {
    db,
    secrets: options.secrets ?? new FakeSecrets(),
    pollMs: 2,
  };
  return completeQuickBooksConnection(deps, {
    tenantId,
    realmId: options.realmId ?? 'realm-a',
    environment: options.environment ?? 'sandbox',
    tokens: { refreshToken: `fixture-refresh-${tenantId}` },
  });
}

/** An issued frozen invoice with one taxed line. */
export async function issuedFixtureInvoice(
  db: DatabaseInterface,
  tenantId: string,
  options: { sku?: string; flatCustomerExternalId?: string } = {},
): Promise<{
  invoice: Invoice;
  customerId: string;
  lineId: string;
  taxCodeId: string;
  componentId: string;
}> {
  await ensureTenantTaxCodes(db, tenantId);
  return withTenant({ tenantId }, async () => {
    const components = await TaxComponentCollection.create({ db });
    const component = await components.create({ name: 'GST', percent: '5' });
    const codes = await TaxCodeCollection.create({ db });
    const code = await codes.create({
      code: 'gst',
      name: 'GST',
      components: [{ taxComponentId: String(component.id), compound: false }],
    });
    const settings = await TaxSettingsCollection.create({ db });
    const current = await settings.getOrCreateForTenant(tenantId);
    current.defaultSalesTaxCodeId = String(code.id);
    current.defaultLineAmountType = 'exclusive';
    current.taxRoundingScope = 'document';
    await current.save();
    const customer = await (await CustomerCollection.create({ db })).create({
      defaultTaxCodeId: String(code.id),
    });
    const invoices = await InvoiceCollection.create({ db });
    const invoice = await invoices.create({
      customerId: String(customer.id),
      customerExternalId: options.flatCustomerExternalId ?? 'flat-unscoped',
      invoiceNumber: `INV-${tenantId}`,
      currency: 'CAD',
    });
    const line = await (await InvoiceLineItemCollection.create({ db })).create({
      invoiceId: String(invoice.id),
      description: 'Consulting',
      sku: options.sku ?? '',
      quantity: 2,
      unitPrice: 100,
      taxMode: 'override',
      taxCodeId: String(code.id),
    });
    const stored = await invoices.get({ id: invoice.id }, { cache: false });
    if (!stored) throw new Error('Expected invoice');
    stored.status = InvoiceStatus.SENT;
    await stored.save();
    return {
      invoice: stored,
      customerId: String(customer.id),
      lineId: String(line.id),
      taxCodeId: String(code.id),
      componentId: String(component.id),
    };
  });
}
