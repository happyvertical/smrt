import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import '../index.js';
import { randomUUID } from 'node:crypto';
import type { PrincipalRun } from '@happyvertical/smrt-agents';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG,
  CustomerCollection,
  createCommerceMoneyTools,
  ensureCommerceTenant,
  InvoiceCollection,
  InvoiceLineItemCollection,
  Payment,
  PayoutCollection,
  previewInvoiceMoney,
} from '../index.js';
import { proveCustomerFunds } from './helpers/customer-funds-suite.js';
import { proveHistoricalCustomerFunds } from './helpers/historical-customer-funds-suite.js';
import { proveHistoricalSourceChildren } from './helpers/historical-lines-suite.js';
import { proveObservedPurchasePrice } from './helpers/observed-purchase-price-suite.js';

/** Observe real construction without changing constructor identity or lifecycle.
 * Distinct service stack locations ensure every swept site is exercised. */
const expectedSites: Record<string, number> = {
  'historical-customer-funds.ts|HistoricalCustomerFunds': 2,
  'historical-customer-funds.ts|HistoricalCustomerFundsAllocation': 2,
  'historical-customer-funds.ts|Payment': 1,
  'historical-sales-money.ts|HistoricalSalesLine': 1,
  'commerce-money-tools.ts|InvoiceLineItem': 1,
  'document-money.ts|InvoiceLineItem': 1,
  'customer-funds.ts|Payment': 1,
  'customer-funds.ts|PaymentAllocation': 1,
  'observed-purchase-price.ts|PurchasePriceObservation': 1,
  'collections/PayoutCollection.ts|Payout': 1,
};

describe.each([false, true])('#4931 app replacement = %s', (replace) => {
  let app: Record<string, unknown> | undefined;
  let restoreRegistry: (() => void) | undefined;
  const seen = new Map<string, Set<string>>();
  let restoreSpy: (() => void) | undefined;
  beforeAll(async () => {
    restoreRegistry = snapshotObjectRegistryState();
    if (replace) app = await import('./issue-4931-app.fixture.js');
  });
  beforeEach(() => {
    const resolve =
      ObjectRegistry.resolveEffectiveConstructor.bind(ObjectRegistry);
    const spy = vi
      .spyOn(ObjectRegistry, 'resolveEffectiveConstructor')
      .mockImplementation((model) => {
        const effective = resolve(model);
        const stack = new Error().stack ?? '';
        const key = Object.keys(expectedSites).find((key) => {
          const [file, name] = key.split('|');
          return name === model.name && stack.includes(`/src/${file}:`);
        });
        if (!key) return effective;
        const file = key.split('|')[0];
        const location =
          stack.split('\n').find((line) => line.includes(`/src/${file}:`)) ??
          '';
        return new Proxy(effective, {
          construct(target, args) {
            const instance = Reflect.construct(target, args);
            expect(instance.constructor).toBe(app?.[model.name] ?? model);
            const locations = seen.get(key) ?? new Set<string>();
            locations.add(location);
            seen.set(key, locations);
            return instance;
          },
        });
      });
    restoreSpy = () => spy.mockRestore();
  });
  afterEach(() => restoreSpy?.());
  afterAll(() => {
    restoreRegistry?.();
    expect(
      Object.fromEntries(
        Object.keys(expectedSites).map((key) => [
          key,
          seen.get(key)?.size ?? 0,
        ]),
      ),
    ).toEqual(expectedSites);
  });

  for (const [name, scenario] of Object.entries({
    customerFunds: proveCustomerFunds,
    historicalFunds: proveHistoricalCustomerFunds,
    historicalLines: proveHistoricalSourceChildren,
    observedPurchase: proveObservedPurchasePrice,
  })) {
    it(`uses the effective constructors throughout ${name}`, async () => {
      const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
      enableTenancy();
      try {
        await scenario(db);
      } finally {
        disableTenancy();
        await db.close?.();
      }
    }, 60000);
  }
  it('keeps payouts unsaved and builds preview/tool lines with the effective class', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    try {
      const payouts = await PayoutCollection.create({ db });
      const payout = await payouts.createFromPayment({
        payment: new Payment({ amount: 1000, currency: 'CAD' }),
        vendorId: 'vendor',
        operatorFee: 100,
      });
      expect(payout.constructor).toBe(
        app?.Payout ??
          ObjectRegistry.resolveEffectiveConstructor(
            PayoutCollection._itemClass,
          ),
      );
      expect(payout.id).toBeFalsy();
      expect(payout.isPersisted).toBe(false);
      expect(payout.db).toBe(db);
      const tenantId = randomUUID();
      await withTenant({ tenantId }, async () => {
        await ensureCommerceTenant(db, tenantId);
        const customer = await (await CustomerCollection.create({ db })).create(
          { name: 'App customer' },
        );
        const invoice = await (await InvoiceCollection.create({ db })).create({
          customerId: customer.id,
          currency: 'CAD',
          invoiceNumber: randomUUID(),
        });
        await previewInvoiceMoney({
          db,
          tenantId,
          invoiceId: String(invoice.id),
          draft: {
            lines: [
              {
                description: 'Preview',
                quantity: 1,
                unitPrice: 100,
                taxMode: 'none',
              },
            ],
          },
        });
        expect(
          await (await InvoiceLineItemCollection.create({ db })).findByInvoice(
            String(invoice.id),
          ),
        ).toHaveLength(0);
        const tool = createCommerceMoneyTools().find(
          (t) => t.slug === COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG,
        );
        if (!tool) throw new Error('Missing line add tool');
        const run = {
          context: { tenantId, database: db },
          assertToolAllowed() {},
          async assertOperation() {},
        } as unknown as PrincipalRun;
        await tool.execute({
          run,
          db,
          args: {
            invoiceId: invoice.id,
            description: 'Tool line',
            quantity: 1,
            unitPrice: 100,
            taxCode: 'out-of-scope',
          },
        });
      });
    } finally {
      disableTenancy();
      await db.close?.();
    }
  });
});
