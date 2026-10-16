/**
 * Sample document money on smrt-commerce's money model (smrt#3988, released
 * in 0.56.1). The arithmetic is the package's own: `calculateMoneyDocument`
 * and `resolveLineTaxCode` from `@happyvertical/smrt-commerce/money` (pure,
 * browser-safe), never a copy. This module only supplies the sample tenant's
 * tax codes and maps sample rows to and from the calculator.
 *
 * What a settled document holds (minor units throughout):
 *
 *   line amount     = quantity x unitPrice - discount
 *                     exclusive: the line's net; inclusive: its gross, and
 *                     net = amount - taxAmount
 *   line taxAmount  = the line's tax from its resolved tax code, one entry
 *                     per component in `taxComponentsJson`
 *   subtotal        = the lines' net
 *   taxAmount       = the lines' tax
 *   totalAmount     = subtotal + taxAmount
 *   discountTotal   = the lines' discounts, informational only: they are
 *                     already inside every line amount and must never be
 *                     subtracted again
 *
 * A line's discount is `discountType` `none`, `percent` (`discountRate` is
 * exact percent text, "10" is 10%) or `amount` (`discount` in minor units).
 * Tax codes resolve per line: a line override (`taxMode: 'override'` with
 * `taxCodeId`), an exempt customer, the product's code, the customer's code,
 * then the app default.
 */
import {
  calculateMoneyDocument,
  type LineAmountType,
  type MoneyDiscountInput,
  type ResolvableTaxCodeInput,
  resolveLineTaxCode,
  type TaxCodeAppliesTo,
  type TaxCodeKind,
  type TaxRoundingScope,
} from '@happyvertical/smrt-commerce/money';
import { ISO_4217_MINOR_UNITS } from '@happyvertical/smrt-ui/currency';

export { MoneyValidationError } from '@happyvertical/smrt-commerce/money';
export type { LineAmountType, TaxRoundingScope };

type Row = Readonly<Record<string, unknown>>;

export interface SampleTaxComponent {
  id: string;
  /** The example pack's key, or `cookbook-<percent>` for the default. */
  key: string;
  name: string;
  /** Exact percent text: "7" is 7%. */
  percent: string;
  recoverable: boolean;
}

export interface SampleTaxCode {
  id: string;
  code: string;
  name: string;
  kind: TaxCodeKind;
  appliesTo: TaxCodeAppliesTo;
  active: boolean;
  components: readonly SampleTaxComponent[];
}

/** A stable id for a sample tax row (a UUID-shaped FNV hash, like `fakeId`). */
function taxId(key: string): string {
  let h = 0x811c9dc5;
  const parts: string[] = [];
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i) + round;
      h = Math.imul(h, 0x01000193);
    }
    parts.push((h >>> 0).toString(16).padStart(8, '0'));
  }
  const hex = parts.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const code = (
  value: string,
  name: string,
  kind: TaxCodeKind,
  components: readonly SampleTaxComponent[] = [],
): SampleTaxCode => ({
  id: taxId(`tax-code:${value}`),
  code: value,
  name,
  kind,
  appliesTo: 'both',
  active: true,
  components,
});

/**
 * The codes every tenant is seeded with, which report differently and carry
 * no components.
 */
export const SEEDED_TAX_CODES: readonly SampleTaxCode[] = [
  code('exempt', 'Exempt', 'exempt'),
  code('zero-rated', 'Zero-rated', 'zero-rated'),
  code('out-of-scope', 'Out of scope', 'out-of-scope'),
];

/**
 * smrt-commerce's `COMMON_TAX_CODE_EXAMPLE_PACK` (Canada GST, BC GST+PST,
 * Ontario HST, UK VAT, Australian GST, New Zealand GST), as the planner's
 * tenant has imported it (`applyTaxCodeExamplePack`). The pack is exported
 * only from the package root, which is not browser-safe, so it is restated
 * here and `tests/money.test.ts` compares it with the package's; delete the
 * copy when `./money` exports it (smrt#4023).
 */
export const TAX_CODE_EXAMPLE_PACK = {
  id: 'common-sales-taxes-v1',
  components: [
    { key: 'ca-gst-5', name: 'Canada GST 5%', percent: '5', recoverable: true },
    { key: 'ca-pst-bc-7', name: 'BC PST 7%', percent: '7', recoverable: false },
    {
      key: 'ca-hst-on-13',
      name: 'Ontario HST 13%',
      percent: '13',
      recoverable: true,
    },
    { key: 'uk-vat-20', name: 'UK VAT 20%', percent: '20', recoverable: true },
    {
      key: 'au-gst-10',
      name: 'Australia GST 10%',
      percent: '10',
      recoverable: true,
    },
    {
      key: 'nz-gst-15',
      name: 'New Zealand GST 15%',
      percent: '15',
      recoverable: true,
    },
  ],
  codes: [
    {
      code: 'ca-gst',
      name: 'Canada GST',
      appliesTo: 'both',
      componentKeys: ['ca-gst-5'],
    },
    {
      code: 'ca-gst-pst-bc',
      name: 'BC GST + PST',
      appliesTo: 'both',
      componentKeys: ['ca-gst-5', 'ca-pst-bc-7'],
    },
    {
      code: 'ca-hst-on',
      name: 'Ontario HST',
      appliesTo: 'both',
      componentKeys: ['ca-hst-on-13'],
    },
    {
      code: 'uk-vat-standard',
      name: 'UK VAT standard',
      appliesTo: 'both',
      componentKeys: ['uk-vat-20'],
    },
    {
      code: 'au-gst',
      name: 'Australia GST',
      appliesTo: 'both',
      componentKeys: ['au-gst-10'],
    },
    {
      code: 'nz-gst',
      name: 'New Zealand GST',
      appliesTo: 'both',
      componentKeys: ['nz-gst-15'],
    },
  ],
} as const;

const component = (
  key: string,
  name: string,
  percent: string,
  recoverable: boolean,
): SampleTaxComponent => ({
  id: taxId(`tax-component:${key}`),
  key,
  name,
  percent,
  recoverable,
});

const PACK_COMPONENTS = new Map(
  TAX_CODE_EXAMPLE_PACK.components.map((c) => [
    c.key,
    component(c.key, c.name, c.percent, c.recoverable),
  ]),
);

/** The example pack's codes with their components. */
export const EXAMPLE_TAX_CODES: readonly SampleTaxCode[] =
  TAX_CODE_EXAMPLE_PACK.codes.map((c) => ({
    ...code(
      c.code,
      c.name,
      'taxable',
      c.componentKeys.flatMap((key) => {
        const found = PACK_COMPONENTS.get(key);
        return found ? [found] : [];
      }),
    ),
    appliesTo: c.appliesTo,
  }));

/** The pack's codes that suit a currency, by the jurisdiction they name. */
const PACK_CURRENCY: Readonly<Record<string, string>> = {
  'ca-gst': 'CAD',
  'ca-gst-pst-bc': 'CAD',
  'ca-hst-on': 'CAD',
  'uk-vat-standard': 'GBP',
  'au-gst': 'AUD',
  'nz-gst': 'NZD',
};

/** A fraction (0.0825) as exact percent text ("8.25"). */
export function percentText(rate: number): string {
  return String(Number((rate * 100).toFixed(6)));
}

/**
 * The app's default sales tax code for its tax-rate setting, exactly as
 * smrt-commerce's cookbook activation (`applyCommerceCookbookSettings`)
 * creates it, so the planner prices what an exported cookbook will: no rate
 * (0) is `out-of-scope`, any other rate the `default-<rate>` code with one
 * `Cookbook <rate>%` component. The example pack's codes are only ever chosen
 * explicitly, on a line (`examplePackCodeFor`).
 */
export function defaultTaxCode(rate: number): SampleTaxCode {
  const outOfScope = SEEDED_TAX_CODES.find((c) => c.kind === 'out-of-scope');
  if (!(rate > 0) && outOfScope) return outOfScope;
  const percent = percentText(rate);
  return code(
    `default-${percent.replace('.', '_')}`,
    `Default ${percent}%`,
    'taxable',
    [component(`cookbook-${percent}`, `Cookbook ${percent}%`, percent, false)],
  );
}

/**
 * The example-pack code a sample line in an app of this currency may choose
 * for itself: the pack's code with the most components for that country
 * (BC GST + PST for CAD), else none.
 */
export function examplePackCodeFor(
  currency: string,
): SampleTaxCode | undefined {
  return EXAMPLE_TAX_CODES.filter(
    (c) => PACK_CURRENCY[c.code] === currency.toUpperCase(),
  ).sort((a, b) => b.components.length - a.components.length)[0];
}

/** Every tax code of the sample tenant: the seeded ones, the default, the pack. */
export function sampleTaxCodes(rate: number): SampleTaxCode[] {
  const fallback = defaultTaxCode(rate);
  const all = [...SEEDED_TAX_CODES, fallback, ...EXAMPLE_TAX_CODES];
  return all.filter((c, i) => all.findIndex((o) => o.id === c.id) === i);
}

/** The components of the sample tenant's codes, each once. */
export function sampleTaxComponents(codes: readonly SampleTaxCode[]) {
  const seen = new Map<string, SampleTaxComponent>();
  for (const c of codes)
    for (const part of c.components) seen.set(part.id, part);
  return [...seen.values()];
}

/** What a settled line stores per tax component (smrt's `taxComponentsJson`). */
export interface LineTaxComponent {
  taxComponentId: string;
  name: string;
  percent: string;
  taxMinor: number;
}

/** One `DocumentTax`-shaped row: a code/component's taxable base and tax. */
export interface DocumentTaxRow {
  taxCodeId: string | null;
  taxComponentId: string | null;
  name: string;
  percent: string;
  taxable: number;
  tax: number;
}

export interface MoneyContext {
  lineAmountType: LineAmountType;
  roundingScope: TaxRoundingScope;
  currency: string;
  codes: readonly SampleTaxCode[];
  /** The app's default sales code. */
  appDefaultCodeId: string | null;
  /** The document's customer is tax exempt. */
  customerTaxExempt?: boolean;
  /** The customer's own code (`Customer.defaultTaxCodeId`). */
  partyCodeId?: string | null;
  /** A line's product code (`Product.defaultSalesTaxCodeId`), by product id. */
  productCodeOf?: (productId: string) => string | null | undefined;
}

/** The fields a document's calculation writes on each of its lines. */
export type SettledLineMoney = {
  discount: number;
  amount: number;
  taxAmount: number;
  taxCodeId: string | null;
  taxCodeCode: string | null;
  taxCodeName: string | null;
  taxComponentsJson: string;
  taxRate: number;
};

export interface SettledDocument<L extends Row> {
  lines: (L & SettledLineMoney)[];
  subtotal: number;
  discountTotal: number;
  taxAmount: number;
  totalAmount: number;
  taxes: DocumentTaxRow[];
}

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const minor = (value: unknown): number => Math.round(num(value));

/** A line's discount as the calculator takes it. */
export function lineDiscount(line: Row): MoneyDiscountInput {
  if (line.discountType === 'percent') {
    const rate = String(line.discountRate ?? '').trim();
    return rate && Number(rate) !== 0
      ? { kind: 'percent', rate: percentRate(rate) }
      : { kind: 'none' };
  }
  if (line.discountType === 'amount') {
    const amount = minor(line.discount);
    return amount ? { kind: 'amount', minor: amount } : { kind: 'none' };
  }
  return { kind: 'none' };
}

/** Exact percent text with at most six decimals ("12.5"). */
function percentRate(rate: string): string {
  const n = Number(rate);
  return Number.isFinite(n) ? String(Number(n.toFixed(6))) : '0';
}

/** A supported ISO 4217 code for the calculator: the row's, else the app's. */
export function moneyCurrency(value: unknown, fallback = 'USD'): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return code in ISO_4217_MINOR_UNITS ? code : fallback;
}

const quantity = (value: unknown): number => {
  const n = num(value);
  return n < 0 ? 0 : Number(n.toFixed(6));
};

function resolvable(c: SampleTaxCode): ResolvableTaxCodeInput {
  return {
    id: c.id,
    kind: c.kind,
    active: c.active,
    appliesTo: c.appliesTo,
    components: c.components.map((part) => ({
      taxComponentId: part.id,
      percent: part.percent,
      compound: false,
    })),
  };
}

/**
 * A document's lines and totals on the money model. Each line keeps its own
 * fields and gains `discount` (what was taken off, in minor units),
 * `amount`, `taxAmount`, `taxCodeId` / `taxCodeCode` / `taxCodeName`,
 * `taxComponentsJson` and `taxRate` (the sum of its components' percents as a
 * fraction, the field smrt keeps beside them). Throws smrt's
 * `MoneyValidationError` on money the model refuses (a discount above the
 * line's price, an unknown override code).
 */
export function settleDocument<L extends Row>(
  lines: readonly L[],
  context: MoneyContext,
): SettledDocument<L> {
  const codes = Object.fromEntries(
    context.codes.map((c) => [c.id, resolvable(c)]),
  );
  const byId = new Map(context.codes.map((c) => [c.id, c]));
  const exempt = context.codes.find((c) => c.kind === 'exempt')?.id ?? null;
  const outOfScope =
    context.codes.find((c) => c.kind === 'out-of-scope')?.id ?? null;
  const ids = lines.map((line, i) =>
    typeof line.id === 'string' && line.id ? line.id : `line-${i}`,
  );
  const resolved = lines.map((line) => {
    const override =
      line.taxMode === 'override' && typeof line.taxCodeId === 'string'
        ? line.taxCodeId || null
        : null;
    const productId =
      typeof line.productId === 'string' && line.productId
        ? line.productId
        : null;
    return resolveLineTaxCode(
      { lineAmountType: context.lineAmountType, lineOverride: override },
      {
        direction: 'sales',
        codes,
        customerTaxExempt: context.customerTaxExempt ?? false,
        exemptCodeId: exempt,
        productCodeId: productId
          ? (context.productCodeOf?.(productId) ?? null)
          : null,
        partyCodeId: context.partyCodeId ?? null,
        appDefaultCodeId: context.appDefaultCodeId,
        outOfScopeCodeId: outOfScope,
      },
    ).taxCode;
  });
  const result = calculateMoneyDocument({
    currency: context.currency,
    lineAmountType: context.lineAmountType,
    roundingScope: context.roundingScope,
    lines: lines.map((line, i) => ({
      id: ids[i] as string,
      quantity: quantity(line.quantity),
      unitPrice: minor(line.unitPrice),
      discount: lineDiscount(line),
      taxCode: resolved[i] ?? null,
    })),
  });
  const components = new Map(
    context.codes.flatMap((c) => c.components.map((p) => [p.id, p] as const)),
  );
  const settled = lines.map((line, i): L & SettledLineMoney => {
    const row = result.lines[i];
    const taxCode = resolved[i] ? byId.get(resolved[i].id) : undefined;
    const parts: LineTaxComponent[] = (row?.components ?? []).map((part) => {
      const found = components.get(part.taxComponentId);
      return {
        taxComponentId: part.taxComponentId,
        name: found?.name ?? '',
        percent: found?.percent ?? '0',
        taxMinor: part.taxMinor,
      };
    });
    const percent = parts.reduce((sum, p) => sum + Number(p.percent), 0);
    return {
      ...line,
      discount: row?.discountMinor ?? 0,
      amount: row?.amountMinor ?? 0,
      taxAmount: row?.taxMinor ?? 0,
      taxCodeId: taxCode?.id ?? null,
      taxCodeCode: taxCode?.code ?? null,
      taxCodeName: taxCode?.name ?? null,
      taxComponentsJson: JSON.stringify(parts),
      taxRate: Number((percent / 100).toFixed(6)),
    };
  });
  const taxes: DocumentTaxRow[] = result.taxes.map((tax) => {
    const part = tax.taxComponentId
      ? components.get(tax.taxComponentId)
      : undefined;
    const owner = tax.taxCodeId ? byId.get(tax.taxCodeId) : undefined;
    return {
      taxCodeId: tax.taxCodeId,
      taxComponentId: tax.taxComponentId,
      name: part?.name ?? owner?.name ?? '',
      percent: part?.percent ?? '0',
      taxable: tax.taxableMinor,
      tax: tax.taxMinor,
    };
  });
  return {
    lines: settled,
    subtotal: result.subtotalMinor,
    discountTotal: result.discountTotalMinor,
    taxAmount: result.taxMinor,
    totalAmount: result.totalMinor,
    taxes,
  };
}

/** The per-component snapshot a settled line stores, or `[]`. */
export function lineTaxComponents(line: Row): LineTaxComponent[] {
  const raw = line.taxComponentsJson;
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (p): p is LineTaxComponent =>
            typeof p === 'object' &&
            p !== null &&
            typeof p.taxComponentId === 'string' &&
            Number.isSafeInteger(p.taxMinor),
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * A document's per-component tax as its stored line snapshots say: each
 * component's tax is the sum of what the lines stored for it, and its taxable
 * base the sum of those lines' net (`amount`, less `taxAmount` when prices
 * include tax). Sums of stored values only: nothing is recalculated, the way
 * smrt's `DocumentTax` rows are written from the same calculation.
 */
export function storedTaxRows(
  lines: readonly Row[],
  lineAmountType: LineAmountType,
): DocumentTaxRow[] {
  const rows = new Map<string, DocumentTaxRow>();
  for (const line of lines) {
    const net =
      lineAmountType === 'inclusive'
        ? minor(line.amount) - minor(line.taxAmount)
        : minor(line.amount);
    for (const part of lineTaxComponents(line)) {
      const found = rows.get(part.taxComponentId);
      if (found) {
        found.taxable += net;
        found.tax += part.taxMinor;
      } else {
        rows.set(part.taxComponentId, {
          taxCodeId: typeof line.taxCodeId === 'string' ? line.taxCodeId : null,
          taxComponentId: part.taxComponentId,
          name: part.name,
          percent: part.percent,
          taxable: net,
          tax: part.taxMinor,
        });
      }
    }
  }
  return [...rows.values()];
}

/** What a line comes to before tax is resolved: its price less its discount. */
export function lineAmount(line: Row): number {
  try {
    return (
      settleDocument([line], {
        lineAmountType: 'exclusive',
        roundingScope: 'line',
        currency: 'USD',
        codes: [],
        appDefaultCodeId: null,
      }).lines[0]?.amount ?? 0
    );
  } catch {
    return Math.round(quantity(line.quantity) * minor(line.unitPrice));
  }
}
