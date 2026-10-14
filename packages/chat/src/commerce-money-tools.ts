/** Principal-bound commerce money tools for draft invoices (#3937). */

import type { AITool } from '@happyvertical/ai';
import type {
  PrincipalRun,
  PrincipalTool,
  PrincipalToolContext,
} from '@happyvertical/smrt-agents';
import {
  DocumentTax,
  Invoice,
  InvoiceCollection,
  InvoiceLineItem,
  InvoiceLineItemCollection,
  MoneyValidationError,
  type PreviewInvoiceMoneyInput,
  previewInvoiceMoney,
  serializeInvoiceMcpGet,
  TaxCode,
  TaxCodeCollection,
  TaxSettingsCollection,
} from '@happyvertical/smrt-commerce';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';

export const COMMERCE_TAX_CODES_LIST_TOOL_SLUG = 'commerce.taxCodes.list';
export const COMMERCE_INVOICE_PREVIEW_TOOL_SLUG = 'commerce.invoice.preview';
export const COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG = 'commerce.invoice.line.add';
export const COMMERCE_INVOICE_LINE_UPDATE_TOOL_SLUG =
  'commerce.invoice.line.update';

const TAX_CODE_LIST_FUNCTION_NAME = 'commerce-tax-codes-list';
const INVOICE_PREVIEW_FUNCTION_NAME = 'commerce-invoice-preview';
const INVOICE_LINE_ADD_FUNCTION_NAME = 'commerce-invoice-line-add';
const INVOICE_LINE_UPDATE_FUNCTION_NAME = 'commerce-invoice-line-update';

type ToolArgs = Record<string, unknown>;

function tool(
  slug: string,
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: PrincipalTool['execute'],
): PrincipalTool {
  return {
    slug,
    aiTool: {
      type: 'function',
      function: { name, description, parameters },
    } satisfies AITool,
    execute,
  };
}

function requireTenant(run: PrincipalRun): string {
  const tenantId = run.context.tenantId;
  if (!tenantId) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'A tenant is required for commerce money tools',
    );
  }
  return tenantId;
}

function requireDatabase(
  run: PrincipalRun,
  fallback: PrincipalToolContext['db'],
): DatabaseInterface {
  const database = run.context.database ?? fallback;
  if (!database) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Commerce money tools require the authenticated database context',
    );
  }
  return database as DatabaseInterface;
}

function requireText(args: ToolArgs, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() !== value || !value) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${field} must be a nonempty trimmed string`,
    );
  }
  return value;
}

function optionalText(args: ToolArgs, field: string): string | undefined {
  if (!(field in args)) return undefined;
  return requireText(args, field);
}

function requireFiniteNumber(args: ToolArgs, field: string): number {
  const value = args[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${field} must be a finite number`,
    );
  }
  return value;
}

function optionalFiniteNumber(
  args: ToolArgs,
  field: string,
): number | undefined {
  if (!(field in args)) return undefined;
  return requireFiniteNumber(args, field);
}

function optionalInteger(args: ToolArgs, field: string): number | undefined {
  const value = optionalFiniteNumber(args, field);
  if (value !== undefined && !Number.isSafeInteger(value)) {
    throw new MoneyValidationError(
      'UNSAFE_MONEY',
      `${field} must be a safe integer minor-unit amount`,
    );
  }
  return value;
}

function optionalEnum<T extends string>(
  args: ToolArgs,
  field: string,
  values: readonly T[],
): T | undefined {
  if (!(field in args)) return undefined;
  const value = args[field];
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${field} must be one of ${values.join(', ')}`,
    );
  }
  return value as T;
}

function rejectUnknown(args: ToolArgs, allowed: readonly string[]): void {
  for (const field of Object.keys(args)) {
    if (!allowed.includes(field)) {
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        `${field} is not writable through this commerce money tool`,
      );
    }
  }
}

async function resolveTaxCode(
  db: DatabaseInterface,
  tenantId: string,
  code: string,
) {
  const collection = await TaxCodeCollection.create({ db });
  const taxCode = await collection.findByCode(code);
  if (!taxCode || taxCode.tenantId !== tenantId || !taxCode.active) {
    throw new MoneyValidationError(
      'TAX_CODE_NOT_FOUND',
      `Active tax code '${code}' was not found for this tenant`,
    );
  }
  return taxCode;
}

/** Code-based money tools need the frozen-snapshot money model. */
async function requireActiveMoneyV2(
  db: DatabaseInterface,
  tenantId: string,
): Promise<void> {
  const settings = await (
    await TaxSettingsCollection.create({ db })
  ).getForTenant(tenantId);
  if (settings?.moneyModel === 'migrating') {
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Commerce money tools are unavailable while tenant money migration is in progress',
    );
  }
  if (settings?.moneyModel !== 'v2') {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Commerce money tools require active money v2 settings',
    );
  }
}

async function requireInvoice(
  db: DatabaseInterface,
  tenantId: string,
  invoiceId: string,
) {
  const collection = await InvoiceCollection.create({ db });
  const invoice = await collection.get({ id: invoiceId }, { cache: false });
  if (!invoice || invoice.tenantId !== tenantId) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice was not found for this tenant',
    );
  }
  return invoice;
}

const LINE_FIELDS = [
  'description',
  'sku',
  'productId',
  'quantity',
  'unitPrice',
  'discountType',
  'discountRate',
  'discount',
  'taxMode',
  'taxCode',
  'sourceType',
  'sourceId',
  'revenueAccountId',
  'sortOrder',
] as const;

// The calculator's public draft contract is intentionally narrower than the
// line-write contract. Do not accept a field here unless the facade receives
// it; silently dropping a tool argument would make previews misleading.
const PREVIEW_LINE_FIELDS = [
  'id',
  'description',
  'productId',
  'quantity',
  'unitPrice',
  'discountType',
  'discountRate',
  'discount',
  'taxMode',
  'taxCode',
] as const;

async function assignLineInput(
  line: InvoiceLineItem,
  args: ToolArgs,
  db: DatabaseInterface,
  tenantId: string,
  required: boolean,
): Promise<void> {
  const description = required
    ? requireText(args, 'description')
    : optionalText(args, 'description');
  if (description !== undefined) line.description = description;
  for (const field of ['sku', 'sourceType', 'sourceId'] as const) {
    const value = optionalText(args, field);
    if (value !== undefined) line[field] = value;
  }
  const quantity = required
    ? requireFiniteNumber(args, 'quantity')
    : optionalFiniteNumber(args, 'quantity');
  if (quantity !== undefined) line.quantity = quantity;
  const unitPrice = required
    ? requireFiniteNumber(args, 'unitPrice')
    : optionalInteger(args, 'unitPrice');
  if (unitPrice !== undefined && !Number.isSafeInteger(unitPrice)) {
    throw new MoneyValidationError(
      'UNSAFE_MONEY',
      'unitPrice must be a safe integer minor-unit amount',
    );
  }
  if (unitPrice !== undefined) line.unitPrice = unitPrice;
  for (const field of ['discount', 'sortOrder'] as const) {
    const value = optionalInteger(args, field);
    if (value !== undefined) line[field] = value;
  }
  const productId = optionalText(args, 'productId');
  if (productId !== undefined) line.productId = productId;
  const revenueAccountId = optionalText(args, 'revenueAccountId');
  if (revenueAccountId !== undefined) line.revenueAccountId = revenueAccountId;
  const discountType = optionalEnum(args, 'discountType', [
    'none',
    'percent',
    'amount',
  ] as const);
  if (discountType !== undefined) line.discountType = discountType;
  const discountRate = optionalText(args, 'discountRate');
  if (discountRate !== undefined) line.discountRate = discountRate;
  const taxMode = optionalEnum(args, 'taxMode', [
    'inherit',
    'override',
  ] as const);
  const taxCode = optionalText(args, 'taxCode');
  if (taxCode !== undefined) {
    if (taxMode === 'inherit') {
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'taxCode requires taxMode override',
      );
    }
    line.taxCodeId = (await resolveTaxCode(db, tenantId, taxCode)).id ?? '';
    line.taxMode = 'override';
  } else if (taxMode !== undefined) {
    line.taxMode = taxMode;
  }
}

function lineOutput(
  line: InvoiceLineItem,
  run: PrincipalRun,
): Record<string, unknown> {
  return line.toPublicJSON({ permissions: run.permissions });
}

/** Refuse aliases when the public Invoice projection hides money sources. */
async function requireVisibleInvoiceMoneyProjection(
  invoice: Invoice,
  run: PrincipalRun,
): Promise<void> {
  const projected = await serializeInvoiceMcpGet(invoice, {
    permissions: run.permissions,
  });
  if (!Object.hasOwn(projected, 'money')) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice money fields are not visible to the current principal',
    );
  }
}

function asRecord(value: unknown, label: string): ToolArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${label} must be an object`,
    );
  }
  return value as ToolArgs;
}

async function previewDraft(
  input: unknown,
  db: DatabaseInterface,
  tenantId: string,
): Promise<NonNullable<PreviewInvoiceMoneyInput['draft']>> {
  const draft = asRecord(input, 'draft');
  rejectUnknown(draft, ['header', 'lines']);
  const result: NonNullable<PreviewInvoiceMoneyInput['draft']> = {};
  if (draft.header !== undefined) {
    const header = asRecord(draft.header, 'draft.header');
    rejectUnknown(header, [
      'currency',
      'lineAmountType',
      'taxRoundingScope',
      'providerTax',
    ]);
    result.header = {
      ...(header.currency === undefined
        ? {}
        : { currency: requireText(header, 'currency') }),
      ...(header.lineAmountType === undefined
        ? {}
        : {
            lineAmountType: optionalEnum(header, 'lineAmountType', [
              'exclusive',
              'inclusive',
              'none',
            ] as const),
          }),
      ...(header.taxRoundingScope === undefined
        ? {}
        : {
            taxRoundingScope: optionalEnum(header, 'taxRoundingScope', [
              'line',
              'document',
            ] as const),
          }),
      ...(header.providerTax === undefined
        ? {}
        : { providerTax: optionalInteger(header, 'providerTax') }),
    };
  }
  if (draft.lines !== undefined) {
    if (!Array.isArray(draft.lines)) {
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'draft.lines must be an array',
      );
    }
    result.lines = await Promise.all(
      draft.lines.map(async (raw, index) => {
        const line = asRecord(raw, `draft.lines[${index}]`);
        rejectUnknown(line, PREVIEW_LINE_FIELDS);
        const taxCode = optionalText(line, 'taxCode');
        const taxMode = optionalEnum(line, 'taxMode', [
          'inherit',
          'override',
        ] as const);
        if (taxCode !== undefined && taxMode === 'inherit') {
          throw new MoneyValidationError(
            'INVALID_MONEY_INPUT',
            'taxCode requires taxMode override',
          );
        }
        return {
          ...(line.id === undefined ? {} : { id: requireText(line, 'id') }),
          ...(line.description === undefined
            ? {}
            : { description: requireText(line, 'description') }),
          ...(line.productId === undefined
            ? {}
            : { productId: requireText(line, 'productId') }),
          ...(line.quantity === undefined
            ? {}
            : { quantity: requireFiniteNumber(line, 'quantity') }),
          ...(line.unitPrice === undefined
            ? {}
            : { unitPrice: optionalInteger(line, 'unitPrice') }),
          ...(line.discountType === undefined
            ? {}
            : {
                discountType: optionalEnum(line, 'discountType', [
                  'none',
                  'percent',
                  'amount',
                ] as const),
              }),
          ...(line.discountRate === undefined
            ? {}
            : { discountRate: requireText(line, 'discountRate') }),
          ...(line.discount === undefined
            ? {}
            : { discount: optionalInteger(line, 'discount') }),
          ...(taxCode === undefined
            ? {}
            : {
                taxCodeId:
                  (await resolveTaxCode(db, tenantId, taxCode)).id ?? '',
                taxMode: 'override' as const,
              }),
          ...(taxCode === undefined && taxMode !== undefined
            ? { taxMode }
            : {}),
        };
      }),
    );
  }
  return result;
}

const EMPTY_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const LINE_PROPERTIES = {
  description: { type: 'string' },
  sku: { type: 'string' },
  productId: { type: 'string' },
  quantity: { type: 'number', minimum: 0 },
  unitPrice: {
    type: 'integer',
    description: 'Integer minor units, such as cents; 8500 means CAD $85.00.',
  },
  discountType: { type: 'string', enum: ['none', 'percent', 'amount'] },
  discountRate: { type: 'string', description: 'Exact decimal percent text.' },
  discount: { type: 'integer', description: 'Integer minor-unit discount.' },
  taxMode: { type: 'string', enum: ['inherit', 'override'] },
  taxCode: {
    type: 'string',
    description: 'Active tax-code text, for example HST; never a numeric rate.',
  },
  sourceType: { type: 'string' },
  sourceId: { type: 'string' },
  revenueAccountId: { type: 'string' },
  sortOrder: { type: 'integer' },
};

const PREVIEW_LINE_PROPERTIES = {
  id: { type: 'string' },
  description: { type: 'string' },
  productId: { type: 'string' },
  quantity: { type: 'number', minimum: 0 },
  unitPrice: {
    type: 'integer',
    description: 'Integer minor units, such as cents; 8500 means CAD $85.00.',
  },
  discountType: { type: 'string', enum: ['none', 'percent', 'amount'] },
  discountRate: { type: 'string', description: 'Exact decimal percent text.' },
  discount: { type: 'integer', description: 'Integer minor-unit discount.' },
  taxMode: { type: 'string', enum: ['inherit', 'override'] },
  taxCode: {
    type: 'string',
    description: 'Active tax-code text, for example HST; never a numeric rate.',
  },
};

const PREVIEW_HEADER_PROPERTIES = {
  currency: { type: 'string' },
  lineAmountType: {
    type: 'string',
    enum: ['exclusive', 'inclusive', 'none'],
  },
  taxRoundingScope: { type: 'string', enum: ['line', 'document'] },
  providerTax: { type: 'integer', description: 'Integer minor-unit tax.' },
};

/** Build draft-only commerce tools for the existing `extraTools` seam. */
export function createCommerceMoneyTools(): PrincipalTool[] {
  const taxCodes = tool(
    COMMERCE_TAX_CODES_LIST_TOOL_SLUG,
    TAX_CODE_LIST_FUNCTION_NAME,
    'List active tax codes available to the current tenant. Use a returned code such as HST when adding or updating an invoice line; never supply a numeric tax rate.',
    EMPTY_PARAMETERS,
    async ({ run, db }) => {
      run.assertToolAllowed(COMMERCE_TAX_CODES_LIST_TOOL_SLUG);
      await run.assertOperation(TaxCode, 'read');
      const tenantId = requireTenant(run);
      const codes = await (
        await TaxCodeCollection.create({ db: requireDatabase(run, db) })
      ).list({ where: { tenantId, active: true }, orderBy: 'code ASC' });
      return {
        taxCodes: codes.map((code) =>
          code.toPublicJSON({ permissions: run.permissions }),
        ),
      };
    },
  );

  const preview = tool(
    COMMERCE_INVOICE_PREVIEW_TOOL_SLUG,
    INVOICE_PREVIEW_FUNCTION_NAME,
    'Calculate a draft invoice without writing. It returns integer-minor-unit totals, resolved tax code snapshots and per-component tax rows. It refuses past-draft invoices.',
    {
      type: 'object',
      required: ['invoiceId'],
      additionalProperties: false,
      properties: {
        invoiceId: { type: 'string' },
        draft: {
          type: 'object',
          additionalProperties: false,
          properties: {
            header: {
              type: 'object',
              additionalProperties: false,
              properties: PREVIEW_HEADER_PROPERTIES,
            },
            lines: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: PREVIEW_LINE_PROPERTIES,
              },
            },
          },
        },
      },
    },
    async ({ run, args, db }) => {
      run.assertToolAllowed(COMMERCE_INVOICE_PREVIEW_TOOL_SLUG);
      await run.assertOperation(Invoice, 'read');
      await run.assertOperation(InvoiceLineItem, 'read');
      await run.assertOperation(DocumentTax, 'read');
      await run.assertOperation(TaxCode, 'read');
      const tenantId = requireTenant(run);
      const invoiceId = requireText(args, 'invoiceId');
      const database = requireDatabase(run, db);
      const invoice = await requireInvoice(database, tenantId, invoiceId);
      await requireVisibleInvoiceMoneyProjection(invoice, run);
      const draft =
        args.draft === undefined
          ? undefined
          : await previewDraft(args.draft, database, tenantId);
      return previewInvoiceMoney({
        db: database,
        tenantId,
        invoiceId,
        ...(draft ? { draft: draft as PreviewInvoiceMoneyInput['draft'] } : {}),
      });
    },
  );

  const addLine = tool(
    COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG,
    INVOICE_LINE_ADD_FUNCTION_NAME,
    'Add a draft invoice line through the commerce money coordinator. Set taxCode to an active code such as HST, never a numeric tax rate. Monetary values are integer minor units.',
    {
      type: 'object',
      required: [
        'invoiceId',
        'description',
        'quantity',
        'unitPrice',
        'taxCode',
      ],
      additionalProperties: false,
      properties: { invoiceId: { type: 'string' }, ...LINE_PROPERTIES },
    },
    async ({ run, args, db }) => {
      run.assertToolAllowed(COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG);
      await run.assertOperation(Invoice, 'read');
      await run.assertOperation(InvoiceLineItem, 'create');
      await run.assertOperation(TaxCode, 'read');
      rejectUnknown(args, ['invoiceId', ...LINE_FIELDS]);
      const tenantId = requireTenant(run);
      const database = requireDatabase(run, db);
      await requireActiveMoneyV2(database, tenantId);
      const invoiceId = requireText(args, 'invoiceId');
      await requireInvoice(database, tenantId, invoiceId);
      // Validate the complete tool input before any persistence. Collection
      // `create()` saves immediately, which would leave a blank draft line if
      // a later tax-code lookup or scalar validation refused the request.
      const line = new InvoiceLineItem({
        db: database,
        invoiceId,
        tenantId,
      });
      await line.initialize();
      await assignLineInput(line, args, database, tenantId, true);
      await line.save();
      return lineOutput(line, run);
    },
  );

  const updateLine = tool(
    COMMERCE_INVOICE_LINE_UPDATE_TOOL_SLUG,
    INVOICE_LINE_UPDATE_FUNCTION_NAME,
    'Update a draft invoice line through the commerce money coordinator. Use taxCode text such as HST; amount, taxAmount and numeric taxRate are never accepted.',
    {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: { id: { type: 'string' }, ...LINE_PROPERTIES },
    },
    async ({ run, args, db }) => {
      run.assertToolAllowed(COMMERCE_INVOICE_LINE_UPDATE_TOOL_SLUG);
      await run.assertOperation(Invoice, 'read');
      await run.assertOperation(InvoiceLineItem, 'update');
      await run.assertOperation(TaxCode, 'read');
      rejectUnknown(args, ['id', ...LINE_FIELDS]);
      const tenantId = requireTenant(run);
      const database = requireDatabase(run, db);
      await requireActiveMoneyV2(database, tenantId);
      const id = requireText(args, 'id');
      const line = await (
        await InvoiceLineItemCollection.create({ db: database })
      ).get({ id }, { cache: false });
      if (!line || line.tenantId !== tenantId) {
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Invoice line was not found for this tenant',
        );
      }
      await requireInvoice(database, tenantId, line.invoiceId);
      await assignLineInput(line, args, database, tenantId, false);
      await line.save();
      return lineOutput(line, run);
    },
  );

  return [taxCodes, preview, addLine, updateLine];
}
