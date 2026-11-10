import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { recordHistoricalSalesMoney } from '../historical-sales-money.js';
import {
  historicalSalesReportInvoices,
  listHistoricalSalesHeaderFacts,
} from '../historical-sales-reports.js';

describe('native historical report query scope', () => {
  for (const dialect of ['sqlite', 'postgres'] as const)
    it.skipIf(dialect === 'postgres' && !isPostgresAvailable())(
      `filters date, currency, status, authority and tenant before hydrating report rows on ${dialect}`,
      async () => {
        const isolated =
          dialect === 'postgres'
            ? await createIsolatedTestDbFromManifest({
                includeObjects: [
                  'Customer',
                  'Contract',
                  'Invoice',
                  'InvoiceLineItem',
                  'HistoricalSalesLine',
                  'HistoricalCustomerFunds',
                  'HistoricalCustomerFundsAllocation',
                  'DocumentTax',
                  'TaxCode',
                  'TaxComponent',
                  'TaxSettings',
                  'Payment',
                  'PaymentAllocation',
                  'Account',
                  'Journal',
                  'JournalEntry',
                ],
              })
            : null;
        const db =
          isolated?.baseDb ??
          (await getTestDatabase({ type: 'sqlite', url: ':memory:' }));
        enableTenancy();
        const tenantId = randomUUID(),
          otherTenantId = randomUUID();
        try {
          async function original(
            tenant: string,
            key: string,
            issuedOn: string,
            currency: string,
            cancelled = false,
          ) {
            return withTenant({ tenantId: tenant }, async () => {
              const customer = await (
                await CustomerCollection.create({ db })
              ).create({ name: 'Synthetic report customer' });
              const invoices = await InvoiceCollection.create({ db });
              const invoice = await invoices.create({
                customerId: customer.id,
                currency,
                invoiceNumber: key,
              });
              await recordHistoricalSalesMoney({
                db,
                tenantId: tenant,
                invoiceId: String(invoice.id),
                requestId: key,
                evidenceRef: 'synthetic-report-original',
                review: {
                  actorId: 'importer',
                  policyRef: 'explicit-report-fixture',
                },
                source: {
                  namespace: 'report-scope',
                  key,
                  version: '1',
                  issuedOn,
                  dueOn: null,
                  timeZone: 'UTC',
                  approval: null,
                },
                facts: {
                  currency,
                  kind: 'invoice',
                  polarity: 'magnitudes',
                  netMinor: 100,
                  taxMinor: 0,
                  grossMinor: 100,
                  taxComponents: null,
                  detail: { kind: 'header-only' },
                },
              });
              if (cancelled) {
                const loaded = await invoices.get(
                  { id: invoice.id },
                  { cache: false },
                );
                if (!loaded)
                  throw new Error('Missing synthetic historical invoice');
                loaded.cancel();
                await loaded.save();
              }
              return String(invoice.id);
            });
          }
          const first = await original(tenantId, 'first', '2020-01-01', 'CAD');
          const last = await original(tenantId, 'last', '2020-01-31', 'CAD');
          const usd = await original(tenantId, 'usd', '2020-01-15', 'USD');
          await original(tenantId, 'before', '2019-12-31', 'CAD');
          await original(tenantId, 'after', '2020-02-01', 'CAD');
          await original(tenantId, 'cancelled', '2020-01-15', 'CAD', true);
          await original(otherTenantId, 'foreign', '2020-01-15', 'CAD');
          await withTenant({ tenantId }, async () => {
            const customer = await (
              await CustomerCollection.create({ db })
            ).create({ name: 'Current customer' });
            await (await InvoiceCollection.create({ db })).create({
              customerId: customer.id,
              currency: 'CAD',
              issueDate: new Date('2020-01-15T00:00:00Z'),
            });
            const scope = {
              tenantId,
              from: new Date('2020-01-01T00:00:00Z'),
              to: new Date('2020-01-31T00:00:00Z'),
            };
            expect(
              (
                await historicalSalesReportInvoices(db, {
                  ...scope,
                  currency: 'CAD',
                })
              )
                .map((row) => String(row.id))
                .sort(),
            ).toEqual([first, last].sort());
            expect(
              (await listHistoricalSalesHeaderFacts({ ...scope, db }))
                .map((row) => row.invoiceId)
                .sort(),
            ).toEqual([first, last, usd].sort());
            await expect(
              listHistoricalSalesHeaderFacts({
                ...scope,
                tenantId: otherTenantId,
                db,
              }),
            ).rejects.toThrow('explicit active tenant');
          });
        } finally {
          disableTenancy();
          if (isolated) await isolated.cleanup();
          else await db.close?.();
        }
      },
    );
});
