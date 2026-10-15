import { fileURLToPath } from 'node:url';
import type { PrincipalRun, PrincipalTool } from '@happyvertical/smrt-agents';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG,
  COMMERCE_INVOICE_LINE_UPDATE_TOOL_SLUG,
  COMMERCE_INVOICE_PREVIEW_TOOL_SLUG,
  COMMERCE_TAX_CODES_LIST_TOOL_SLUG,
  CustomerCollection,
  createCommerceMoneyTools,
  DocumentTax,
  Invoice,
  InvoiceCollection,
  InvoiceLineItem,
  InvoiceLineItemCollection,
  InvoiceStatus,
  serializeInvoiceMcpGet,
  TaxCode,
  TaxCodeCollection,
  TaxComponentCollection,
  TaxSettingsCollection,
} from '../index.js';
import { withTenantMoneyMigration } from '../tenant-money-barrier.js';
import { seedLegacyMoneyTenant } from './helpers/legacy-money-tenant.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ALL_TOOLS = [
  COMMERCE_TAX_CODES_LIST_TOOL_SLUG,
  COMMERCE_INVOICE_PREVIEW_TOOL_SLUG,
  COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG,
  COMMERCE_INVOICE_LINE_UPDATE_TOOL_SLUG,
];

let isolated: IsolatedTestDbResult | undefined;
let db: DatabaseInterface;

function run(
  tenantId = TENANT_A,
  allowedTools = ALL_TOOLS,
  assertOperation = vi.fn().mockResolvedValue(undefined),
): PrincipalRun {
  return {
    context: {
      userId: USER,
      tenantId,
      database: db,
      permissions: [],
      permissionSet: new Set(),
      membership: null,
      postgresRls: false,
      session: null,
      sessionId: null,
      superAdminBypass: false,
      systemContext: false,
      user: null,
    },
    permissions: [],
    allowedTools,
    isToolAllowed: (tool: string) => allowedTools.includes(tool),
    assertToolAllowed(tool: string) {
      if (!allowedTools.includes(tool)) throw new Error(`denied:${tool}`);
    },
    assertOperation,
  } as PrincipalRun;
}

function tools(): Map<string, PrincipalTool> {
  return new Map(createCommerceMoneyTools().map((tool) => [tool.slug, tool]));
}

async function call(
  tool: PrincipalTool | undefined,
  args: Record<string, unknown>,
  principal = run(),
): Promise<Record<string, any>> {
  if (!tool) throw new Error('Expected commerce money tool');
  return withTenant({ tenantId: principal.context.tenantId as string }, () =>
    tool.execute({ run: principal, args, db }),
  ) as Promise<Record<string, any>>;
}

async function activateV2(tenantId: string): Promise<void> {
  await withTenant({ tenantId }, async () => {
    const components = await TaxComponentCollection.create({ db });
    const gst = await components.create({ name: 'GST', percent: '5' });
    const pst = await components.create({ name: 'PST', percent: '7' });
    const hst = await components.create({ name: 'HST', percent: '13' });
    const codes = await TaxCodeCollection.create({ db });
    const gstCode = await codes.create({
      code: 'GST',
      name: 'Goods and services tax',
      components: [{ taxComponentId: gst.id, compound: false }],
    });
    await codes.create({
      code: 'GST+PST',
      name: 'BC GST and PST',
      components: [
        { taxComponentId: gst.id, compound: false },
        { taxComponentId: pst.id, compound: false },
      ],
    });
    await codes.create({
      code: 'HST',
      name: 'Harmonized sales tax',
      components: [{ taxComponentId: hst.id, compound: false }],
    });
    const settings = await TaxSettingsCollection.create({ db });
    const current = await settings.getOrCreateForTenant(tenantId);
    current.defaultSalesTaxCodeId = gstCode.id;
    current.defaultLineAmountType = 'exclusive';
    current.taxRoundingScope = 'document';
    await current.save();
    // A clean tenant starts on money v2 (#4009); no migration needed.
    if ((await settings.getOrCreateForTenant(tenantId)).moneyModel !== 'v2')
      throw new Error('Expected a clean tenant on money v2');
  });
}

async function createInvoice(tenantId = TENANT_A) {
  return withTenant({ tenantId }, async () => {
    const customers = await CustomerCollection.create({ db });
    const customer = await customers.create({});
    const invoices = await InvoiceCollection.create({ db });
    return invoices.create({
      customerId: customer.id,
      invoiceNumber: `INV-${crypto.randomUUID()}`,
      currency: 'CAD',
    });
  });
}

async function addWorkedExampleLines(
  map: Map<string, PrincipalTool>,
  invoiceId: string,
): Promise<void> {
  const add = map.get(COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG);
  const lines = [
    {
      description: 'Design',
      quantity: 10,
      unitPrice: 8500,
      discountType: 'percent',
      discountRate: '10',
      taxCode: 'GST',
    },
    {
      description: 'Laptop stand',
      quantity: 2,
      unitPrice: 4999,
      discountType: 'amount',
      discount: 500,
      taxCode: 'GST+PST',
    },
    {
      description: 'Software licence',
      quantity: 12,
      unitPrice: 2000,
      taxCode: 'GST+PST',
    },
    {
      description: 'Book',
      quantity: 1,
      unitPrice: 4500,
      taxCode: 'GST',
    },
  ];
  for (const line of lines) await call(add, { invoiceId, ...line });
}

beforeEach(async () => {
  isolated = await createIsolatedTestDbFromManifest({
    manifestPath: fileURLToPath(
      new URL('../../.smrt/manifest.json', import.meta.url),
    ),
    includeObjects: [
      'Customer',
      'DocumentTax',
      'Invoice',
      'InvoiceLineItem',
      'PaymentAllocation',
      'TaxCode',
      'TaxComponent',
      'TaxSettings',
    ],
  });
  db = isolated.db as unknown as DatabaseInterface;
  enableTenancy();
  await activateV2(TENANT_A);
}, 120_000);

afterEach(async () => {
  disableTenancy();
  await isolated?.cleanup();
  isolated = undefined;
});

describe('commerce money principal tools (#3937)', () => {
  it('looks up HST by code and previews the exact A/B calculator totals', async () => {
    const map = tools();
    const previewTool = map.get(COMMERCE_INVOICE_PREVIEW_TOOL_SLUG);
    expect(previewTool?.aiTool.function.parameters).toMatchObject({
      properties: {
        draft: {
          properties: {
            header: {
              additionalProperties: false,
              properties: {
                lineAmountType: { enum: ['exclusive', 'inclusive', 'none'] },
              },
            },
            lines: {
              items: {
                additionalProperties: false,
                properties: {
                  taxCode: expect.objectContaining({ type: 'string' }),
                  unitPrice: expect.objectContaining({ type: 'integer' }),
                },
              },
            },
          },
        },
      },
    });
    const listed = await call(map.get(COMMERCE_TAX_CODES_LIST_TOOL_SLUG), {});
    expect(listed.taxCodes.map((code: { code: string }) => code.code)).toEqual(
      expect.arrayContaining(['GST', 'GST+PST', 'HST']),
    );
    const originalTaxCodePublicJSON = TaxCode.prototype.toPublicJSON;
    const hiddenTaxFields = vi
      .spyOn(TaxCode.prototype, 'toPublicJSON')
      .mockImplementation(function (options) {
        const { code } = originalTaxCodePublicJSON.call(this, options);
        return { code };
      });
    try {
      const redacted = await call(
        map.get(COMMERCE_TAX_CODES_LIST_TOOL_SLUG),
        {},
      );
      expect(redacted.taxCodes).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'GST' })]),
      );
      expect(
        (redacted.taxCodes as Array<Record<string, unknown>>).every(
          (code) =>
            Object.keys(code).length === 1 && typeof code.code === 'string',
        ),
      ).toBe(true);
    } finally {
      hiddenTaxFields.mockRestore();
    }

    const hstInvoice = await createInvoice();
    const hstLine = await call(map.get(COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG), {
      invoiceId: hstInvoice.id,
      description: 'Three hours',
      quantity: 3,
      unitPrice: 8500,
      taxCode: 'HST',
    });
    expect(hstLine).toMatchObject({
      taxCodeCode: 'HST',
      amount: 25500,
      taxAmount: 3315,
    });
    const storedInvoice = await withTenant({ tenantId: TENANT_A }, async () => {
      const invoices = await InvoiceCollection.create({ db });
      const found = await invoices.get({ id: hstInvoice.id }, { cache: false });
      if (!found) throw new Error('Expected stored HST invoice');
      return serializeInvoiceMcpGet(found);
    });
    const stored = await storedInvoice;
    expect(stored).toMatchObject({
      money: {
        source: 'stored',
        moneySnapshotId: expect.any(String),
        lines: [
          expect.objectContaining({ taxCodeCode: 'HST', taxMinor: 3315 }),
        ],
        taxes: [
          expect.objectContaining({ taxCodeCode: 'HST', taxMinor: 3315 }),
        ],
      },
    });

    const exclusive = await createInvoice();
    await addWorkedExampleLines(map, exclusive.id);
    const exclusivePreview = await call(
      map.get(COMMERCE_INVOICE_PREVIEW_TOOL_SLUG),
      { invoiceId: exclusive.id },
    );
    expect(exclusivePreview.header).toMatchObject({
      lineAmountType: 'exclusive',
      subtotalMinor: 114498,
      discountTotalMinor: 9000,
      taxAmountMinor: 8070,
      totalAmountMinor: 122568,
    });

    const inclusive = await createInvoice();
    await withTenant({ tenantId: TENANT_A }, async () => {
      inclusive.lineAmountType = 'inclusive';
      await inclusive.save();
    });
    await addWorkedExampleLines(map, inclusive.id);
    const inclusivePreview = await call(
      map.get(COMMERCE_INVOICE_PREVIEW_TOOL_SLUG),
      { invoiceId: inclusive.id },
    );
    expect(inclusivePreview.header).toMatchObject({
      lineAmountType: 'inclusive',
      subtotalMinor: 107051,
      discountTotalMinor: 9000,
      taxAmountMinor: 7447,
      totalAmountMinor: 114498,
    });
    expect(inclusivePreview.lines[2]).toMatchObject({
      // Stored inclusive amounts remain customer-visible gross; the component
      // snapshot carries the allocated document-scope cent.
      amountMinor: 24000,
      taxComponents: expect.arrayContaining([
        expect.objectContaining({ name: 'GST', taxMinor: 1072 }),
        expect.objectContaining({ name: 'PST', taxMinor: 1500 }),
      ]),
    });

    await expect(
      call(previewTool, {
        invoiceId: exclusive.id,
        draft: { lines: [{ sku: 'silently-dropped-before' }] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });

    const originalToPublicJSON = Invoice.prototype.toPublicJSON;
    const hiddenMoneyField = vi
      .spyOn(Invoice.prototype, 'toPublicJSON')
      .mockImplementation(function (options) {
        const projected = { ...originalToPublicJSON.call(this, options) };
        delete projected.taxAmount;
        return projected;
      });
    try {
      await expect(
        call(previewTool, { invoiceId: exclusive.id }),
      ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
    } finally {
      hiddenMoneyField.mockRestore();
    }

    const lineReadDenied = vi.fn(async (model: unknown) => {
      if (model === InvoiceLineItem)
        throw new Error('denied:invoice-line-items.read');
    });
    await expect(
      call(
        map.get(COMMERCE_INVOICE_PREVIEW_TOOL_SLUG),
        { invoiceId: exclusive.id },
        run(TENANT_A, ALL_TOOLS, lineReadDenied),
      ),
    ).rejects.toThrow('denied:invoice-line-items.read');
    const taxReadDenied = vi.fn(async (model: unknown) => {
      if (model === DocumentTax) throw new Error('denied:document-taxes.read');
    });
    await expect(
      call(
        map.get(COMMERCE_INVOICE_PREVIEW_TOOL_SLUG),
        { invoiceId: exclusive.id },
        run(TENANT_A, ALL_TOOLS, taxReadDenied),
      ),
    ).rejects.toThrow('denied:document-taxes.read');
  });

  it('refuses inactive, foreign, raw-amount and frozen mutations with stable codes', async () => {
    const map = tools();
    const invoice = await createInvoice();
    await withTenant({ tenantId: TENANT_A }, async () => {
      const codes = await TaxCodeCollection.create({ db });
      const hst = await codes.findByCode('HST');
      if (!hst) throw new Error('Expected HST');
      hst.active = false;
      await hst.save();
    });
    await withTenant({ tenantId: TENANT_B }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const component = await components.create({
        name: 'Foreign',
        percent: '5',
      });
      const codes = await TaxCodeCollection.create({ db });
      await codes.create({
        code: 'FOREIGN',
        name: 'Foreign',
        components: [{ taxComponentId: component.id, compound: false }],
      });
    });
    for (const taxCode of ['HST', 'FOREIGN']) {
      await expect(
        call(map.get(COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG), {
          invoiceId: invoice.id,
          description: 'Refused',
          quantity: 1,
          unitPrice: 100,
          taxCode,
        }),
      ).rejects.toMatchObject({ code: 'TAX_CODE_NOT_FOUND' });
    }
    await expect(
      call(map.get(COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG), {
        invoiceId: invoice.id,
        description: 'Forged',
        quantity: 1,
        unitPrice: 100,
        taxCode: 'GST',
        amount: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
    const noLines = await withTenant({ tenantId: TENANT_A }, async () =>
      (await InvoiceLineItemCollection.create({ db })).findByInvoice(
        invoice.id,
      ),
    );
    expect(noLines).toHaveLength(0);
    const unchanged = await withTenant({ tenantId: TENANT_A }, async () =>
      (await InvoiceCollection.create({ db })).get(
        { id: invoice.id },
        { cache: false },
      ),
    );
    expect(unchanged).toMatchObject({
      subtotal: 0,
      taxAmount: 0,
      totalAmount: 0,
    });

    const line = await call(map.get(COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG), {
      invoiceId: invoice.id,
      description: 'Frozen service',
      quantity: 1,
      unitPrice: 100,
      taxCode: 'GST',
    });
    const issued = await withTenant({ tenantId: TENANT_A }, async () => {
      const invoices = await InvoiceCollection.create({ db });
      const fresh = await invoices.get({ id: invoice.id }, { cache: false });
      if (!fresh) throw new Error('Expected invoice to issue');
      fresh.status = InvoiceStatus.SENT;
      return fresh.save();
    });
    await expect(
      call(map.get(COMMERCE_INVOICE_LINE_UPDATE_TOOL_SLUG), {
        id: line.id,
        description: 'Forged frozen edit',
      }),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
    await expect(
      call(map.get(COMMERCE_INVOICE_PREVIEW_TOOL_SLUG), {
        invoiceId: invoice.id,
      }),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });

    // MCP invoice get exposes these stored facts through the commerce-owned
    // `mcp.serializers.get` hook. This custom tool suite proves its own
    // refusal boundary; Core/Commerce cover generated-MCP serialization.
    expect(issued.moneySnapshotId).toEqual(expect.any(String));

    const denied = run(TENANT_A, [], vi.fn());
    await expect(
      call(
        map.get(COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG),
        {
          invoiceId: invoice.id,
          description: 'Denied',
          quantity: 1,
          unitPrice: 100,
          taxCode: 'GST',
        },
        denied,
      ),
    ).rejects.toThrow('denied:commerce.invoice.line.add');
  });

  it('refuses code-based money mutations before legacy or migrating state can change', async () => {
    await seedLegacyMoneyTenant(db, TENANT_B);
    const map = tools();
    const invoice = await createInvoice(TENANT_B);
    const add = map.get(COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG);
    const update = map.get(COMMERCE_INVOICE_LINE_UPDATE_TOOL_SLUG);
    const legacyBefore = await withTenant({ tenantId: TENANT_B }, async () =>
      (await InvoiceCollection.create({ db })).get(
        { id: invoice.id },
        { cache: false },
      ),
    );

    await expect(
      call(
        add,
        {
          invoiceId: invoice.id,
          description: 'Legacy refusal',
          quantity: 1,
          unitPrice: 100,
          taxCode: 'HST',
        },
        run(TENANT_B),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
    const noLegacyLines = await withTenant({ tenantId: TENANT_B }, async () =>
      (await InvoiceLineItemCollection.create({ db })).findByInvoice(
        invoice.id,
      ),
    );
    expect(noLegacyLines).toHaveLength(0);
    const legacyAfterAdd = await withTenant({ tenantId: TENANT_B }, async () =>
      (await InvoiceCollection.create({ db })).get(
        { id: invoice.id },
        { cache: false },
      ),
    );
    expect(legacyAfterAdd).toMatchObject({
      subtotal: legacyBefore?.subtotal,
      taxAmount: legacyBefore?.taxAmount,
      totalAmount: legacyBefore?.totalAmount,
    });

    const legacyLine = await withTenant({ tenantId: TENANT_B }, async () =>
      (await InvoiceLineItemCollection.create({ db })).create({
        invoiceId: invoice.id,
        description: 'Existing legacy line',
        quantity: 1,
        unitPrice: 100,
      }),
    );
    await expect(
      call(
        update,
        { id: legacyLine.id, description: 'Changed' },
        run(TENANT_B),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
    const persistedLegacyLine = await withTenant(
      { tenantId: TENANT_B },
      async () =>
        (await InvoiceLineItemCollection.create({ db })).get(
          { id: legacyLine.id },
          { cache: false },
        ),
    );
    expect(persistedLegacyLine?.description).toBe('Existing legacy line');

    const migrationId = await withTenant({ tenantId: TENANT_B }, async () =>
      (await TaxSettingsCollection.create({ db })).beginMoneyMigration(
        TENANT_B,
      ),
    );
    await expect(
      call(
        update,
        { id: legacyLine.id, description: 'Still blocked' },
        run(TENANT_B),
      ),
    ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
    const migratingLine = await withTenant({ tenantId: TENANT_B }, () =>
      withTenantMoneyMigration(db, TENANT_B, migrationId, async (scope) =>
        (await InvoiceLineItemCollection.create({ db: scope.db })).get(
          { id: legacyLine.id },
          { cache: false },
        ),
      ),
    );
    expect(migratingLine?.description).toBe('Existing legacy line');
  });
});
