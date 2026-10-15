/** Exact, transport-neutral invoice draft validation shared by browser and server. */
import {
  calculateMoneyDocument,
  type MoneyLineResult,
  type MoneyTaxCodeInput,
  MoneyValidationError,
} from '../../money.js';
import { currencyMinorUnitExponent } from './currency.js';

/** Unparsed editable invoice line; invalid values remain caller-owned. */
export interface InvoiceLineDraft {
  /** Stable caller-owned row identity. */
  key: string;
  /** Human-readable item description. */
  description: string;
  /** Optional stock or service code. */
  sku: string;
  /** Nonnegative decimal quantity, at most six decimal places. */
  quantity: string;
  /** Unit price in currency major units. */
  unitPrice: string;
  /** Flat major-unit discount or percentage; unknown drafts remain representable. */
  discountType: string;
  /** Discount in major units or percent according to discountType. */
  discountValue: string;
  /** Inherit the authorized default or use an explicit override. */
  taxMode: string;
  /** Override percent; zero is an explicit exemption, not inheritance. */
  taxRate: string;
}

/** Editable header and lines; clients never supply authoritative calculated totals. */
export interface InvoiceDraftValues {
  /** Customer reference; authorization/existence must be checked by the server. */
  customerId: string;
  /** Calendar issue date, YYYY-MM-DD. */
  issuedOn: string;
  /** Calendar due date, YYYY-MM-DD. */
  dueOn: string;
  /** Uppercase three-letter currency, with Commerce's explicit minor-unit table. */
  currency: string;
  /** Free-form payment terms. */
  paymentTerms: string;
  /** Default tax percent; the server must substitute its authorized rate. */
  taxRate: string;
  /** Caller-owned ordered lines. */
  lines: readonly InvoiceLineDraft[];
}

/** Fields on which line validation may report an error. */
export type InvoiceLineField = keyof InvoiceLineDraft;
/** Stable validation reasons for caller-localized error messages. */
export type InvoiceCalculationError =
  | 'required'
  | 'invalid-decimal'
  | 'precision'
  | 'range'
  | 'invalid-mode'
  | 'discount-exceeds-gross'
  | 'invalid-date'
  | 'duplicate-key'
  | 'invalid-currency';
/** Currency and server-authorized inherited percentage for a line. */
export interface InvoiceCalculationContext {
  /** Uppercase currency code. */
  currency: string;
  /** Default tax percent, for example "5". */
  inheritedTaxRate: string;
}
/** All monetary outputs are safe integer minor units. */
export interface InvoiceCalculatedAmounts {
  /** Rounded quantity times unit price before discounts. */
  grossMinor: number;
  /** Discount rounded to minor units before tax. */
  discountMinor: number;
  /** Gross less discount. */
  subtotalMinor: number;
  /** Rounded tax on the discounted subtotal. */
  taxMinor: number;
  /** Subtotal plus tax. */
  totalMinor: number;
}
/** Success or field errors, with no plausible monetary output for an invalid line. */
export type InvoiceLineCalculation =
  | ({ valid: true; effectiveTaxRate: string } & InvoiceCalculatedAmounts)
  | {
      valid: false;
      errors: Partial<Record<InvoiceLineField, InvoiceCalculationError>>;
    };
/** Header error keys include whole-invoice totals and line membership. */
export type InvoiceDraftField =
  | Exclude<keyof InvoiceDraftValues, 'lines'>
  | 'lines'
  | 'total'
  | 'roundingScope';
/** Server-authorized tax rounding; absent means the historical per-line behavior. */
export interface InvoiceDraftCalculationOptions {
  /** Invoice scope groups equal effective percentages and rounds each group once. */
  roundingScope?: 'line' | 'invoice';
}
/**
 * Aggregate result retains standalone line calculations for validation/audit.
 * With invoice rounding, line tax/total are estimates, NOT allocated invoice
 * amounts, and must not be summed or persisted as authoritative invoice tax.
 */
export type InvoiceDraftCalculation =
  | ({
      valid: true;
      lineResults: readonly InvoiceLineCalculation[];
    } & InvoiceCalculatedAmounts)
  | {
      valid: false;
      errors: Partial<Record<InvoiceDraftField, InvoiceCalculationError>>;
      lineResults: readonly InvoiceLineCalculation[];
    };

interface Decimal {
  coefficient: bigint;
  scale: bigint;
}
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_TEXT = 128;

function decimal(
  value: string,
  precision: number,
): Decimal | InvoiceCalculationError {
  if (
    typeof value !== 'string' ||
    value.length > MAX_TEXT ||
    !/^\d+(?:\.\d+)?$/.test(value)
  )
    return 'invalid-decimal';
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > precision) return 'precision';
  return {
    coefficient: BigInt(whole + fraction),
    scale: 10n ** BigInt(fraction.length),
  };
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function minor(
  value: string,
  digits: number,
): bigint | InvoiceCalculationError {
  const parsed = decimal(value, MAX_TEXT);
  if (typeof parsed === 'string') return parsed;
  const scaled = parsed.coefficient * 10n ** BigInt(digits);
  if (scaled % parsed.scale !== 0n) return 'precision';
  const result = scaled / parsed.scale;
  return result > MAX_MINOR ? 'range' : result;
}

function rate(value: string): Decimal | InvoiceCalculationError {
  const parsed = decimal(value, 6);
  if (typeof parsed === 'string') return parsed;
  return parsed.coefficient > 100n * parsed.scale ? 'range' : parsed;
}

/** Existing model monetary inputs, independent of currency display precision. */
export interface InvoiceMinorLineInput {
  /** Nonnegative quantity with at most six fractional digits. */
  quantity: number;
  /** Signed integer minor units; negative prices support existing credit lines. */
  unitPrice: number;
  /** Flat discount in signed integer minor units; it carries the gross sign. */
  discount: number;
  /** Resolved tax fraction, at most eight fractional digits, in [0, 1]. */
  taxRate: number;
}

function numberDecimal(value: number, precision: number): Decimal {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    throw new RangeError(
      'Invoice rate or quantity is outside the supported range.',
    );
  // The shortest canonical decimal preserves the caller's Number. toFixed can
  // invent different decimal digits that round back to that same binary value.
  const [mantissa, exponent = '0'] = value.toString().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const places = fraction.length - Number(exponent);
  if (places > precision)
    throw new RangeError(
      'Invoice rate or quantity exceeds the supported decimal precision.',
    );
  const coefficient = BigInt(whole + fraction);
  return places < 0
    ? { coefficient: coefficient * 10n ** BigInt(-places), scale: 1n }
    : { coefficient, scale: 10n ** BigInt(places) };
}

function decimalText(value: Decimal): string {
  if (value.scale === 1n) return value.coefficient.toString();
  const places = value.scale.toString().length - 1;
  const digits = value.coefficient.toString().padStart(places + 1, '0');
  const split = digits.length - places;
  return `${digits.slice(0, split)}.${digits.slice(split)}`
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}

/** An in-memory single-rate tax code for editor previews of a percent rate. */
function rateTaxCode(percent: string): MoneyTaxCodeInput {
  const normalized =
    percent
      .replace(/^0+(?=\d)/, '')
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '') || '0';
  return normalized === '0'
    ? { id: 'rate-zero', kind: 'zero-rated', components: [] }
    : {
        id: `rate-${normalized}`,
        kind: 'taxable',
        components: [
          {
            taxComponentId: `rate-${normalized}`,
            percent: normalized,
            compound: false,
          },
        ],
      };
}

/**
 * Exact model calculation, including existing negative-price credit lines.
 * Throws before persistence for unsafe money, invalid quantity, or invalid tax.
 */
export function calculateInvoiceMinorLine(
  input: InvoiceMinorLineInput,
): InvoiceCalculatedAmounts {
  for (const amount of [input.unitPrice, input.discount])
    if (!Number.isSafeInteger(amount))
      throw new RangeError('Invoice money must be safe integer minor units.');
  if (input.taxRate > 1)
    throw new RangeError('Invoice tax rate is outside the supported range.');
  numberDecimal(input.quantity, 6);
  const tax = numberDecimal(input.taxRate, 8);
  const percent = decimalText({
    coefficient: tax.coefficient * 100n,
    scale: tax.scale,
  });
  let result: MoneyLineResult;
  try {
    result = calculateMoneyDocument({
      currency: 'USD',
      lineAmountType: 'exclusive',
      roundingScope: 'line',
      lines: [
        {
          id: 'line',
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          discount:
            input.discount === 0
              ? { kind: 'none' }
              : { kind: 'amount', minor: input.discount },
          taxCode: rateTaxCode(percent),
        },
      ],
    }).lines[0];
  } catch (cause) {
    if (cause instanceof MoneyValidationError)
      throw new RangeError(cause.message, { cause });
    throw cause;
  }
  return {
    grossMinor: result.grossMinor,
    discountMinor: result.discountMinor,
    subtotalMinor: result.netMinor,
    taxMinor: result.taxMinor,
    totalMinor: result.netMinor + result.taxMinor,
  };
}

/** Validated line fields suitable for the existing model's resolved money columns. */
export interface InvoiceResolvedLine extends InvoiceMinorLineInput {
  /** Validated item description. */
  description: string;
  /** Caller stock code. */
  sku: string;
  /** Recomputed total; never copied from a browser total field. */
  amount: number;
}

/**
 * Resolve a validated editor draft to model fields. Percentage discounts become
 * exact flat minor units; inherited tax becomes the authorized effective rate.
 * Keep the raw draft alongside these fields when reopening its editing modes.
 */
export function resolveInvoiceLineDraft(
  line: InvoiceLineDraft,
  context: InvoiceCalculationContext,
): InvoiceResolvedLine {
  const result = calculateInvoiceLine(line, context);
  if (!result.valid)
    throw new RangeError(
      `Invalid invoice line: ${JSON.stringify(result.errors)}`,
    );
  const quantity = Number(line.quantity);
  const sourceQuantity = decimal(line.quantity, 6);
  const storedQuantity = numberDecimal(quantity, 6);
  if (
    typeof sourceQuantity === 'string' ||
    sourceQuantity.coefficient * storedQuantity.scale !==
      storedQuantity.coefficient * sourceQuantity.scale
  )
    throw new RangeError(
      'Invoice quantity cannot round-trip through numeric persistence.',
    );
  const [whole, fraction = ''] = result.effectiveTaxRate.split('.');
  const rateDigits = BigInt(whole + fraction)
    .toString()
    .padStart(fraction.length + 3, '0');
  const split = rateDigits.length - fraction.length - 2;
  const taxRate = Number(
    `${rateDigits.slice(0, split)}.${rateDigits.slice(split)}`,
  );
  const unitPrice = minor(
    line.unitPrice,
    currencyMinorUnitExponent(context.currency),
  );
  if (typeof unitPrice !== 'bigint')
    throw new RangeError('Invalid invoice unit price.');
  const resolved = {
    description: line.description,
    sku: line.sku,
    quantity,
    unitPrice: Number(unitPrice),
    discount: result.discountMinor,
    taxRate,
    amount: result.totalMinor,
  };
  const model = calculateInvoiceMinorLine(resolved);
  if (
    model.totalMinor !== result.totalMinor ||
    model.subtotalMinor !== result.subtotalMinor ||
    model.taxMinor !== result.taxMinor
  )
    throw new RangeError('Invoice draft and persisted calculation disagree.');
  return resolved;
}

/**
 * Validate and calculate one line using decimal integer arithmetic. Round half
 * up separately at gross, percentage discount, and tax boundaries. No rounding
 * is permitted when parsing a price or flat discount into currency minor units.
 */
export function calculateInvoiceLine(
  line: InvoiceLineDraft,
  context: InvoiceCalculationContext,
): InvoiceLineCalculation {
  const errors: Partial<Record<InvoiceLineField, InvoiceCalculationError>> = {};
  if (!line.key?.trim()) errors.key = 'required';
  if (!line.description?.trim()) errors.description = 'required';
  if (!/^[A-Z]{3}$/.test(context.currency))
    return { valid: false, errors: { unitPrice: 'invalid-currency' } };
  const digits = currencyMinorUnitExponent(context.currency);
  const quantity = decimal(line.quantity, 6);
  const price = minor(line.unitPrice, digits);
  if (typeof quantity === 'string') errors.quantity = quantity;
  else if (quantity.coefficient > MAX_MINOR * quantity.scale)
    errors.quantity = 'range';
  else {
    try {
      const persisted = numberDecimal(Number(line.quantity), 6);
      if (
        quantity.coefficient * persisted.scale !==
        persisted.coefficient * quantity.scale
      )
        errors.quantity = 'precision';
    } catch {
      errors.quantity = 'precision';
    }
  }
  if (typeof price === 'string') errors.unitPrice = price;
  if (line.discountType !== 'flat' && line.discountType !== 'percent')
    errors.discountType = 'invalid-mode';
  if (line.taxMode !== 'inherit' && line.taxMode !== 'override')
    errors.taxMode = 'invalid-mode';
  const discount =
    line.discountType === 'percent'
      ? rate(line.discountValue)
      : minor(line.discountValue, digits);
  if (typeof discount === 'string') errors.discountValue = discount;
  const effectiveTaxRate =
    line.taxMode === 'inherit' ? context.inheritedTaxRate : line.taxRate;
  const tax = rate(effectiveTaxRate);
  if (typeof tax === 'string') errors.taxRate = tax;
  if (
    Object.keys(errors).length ||
    typeof quantity === 'string' ||
    typeof price === 'string' ||
    typeof discount === 'string' ||
    typeof tax === 'string'
  )
    return { valid: false, errors };
  let calculated: MoneyLineResult;
  try {
    calculated = calculateMoneyDocument({
      currency: context.currency,
      lineAmountType: 'exclusive',
      roundingScope: 'line',
      lines: [
        {
          id: line.key,
          quantity: Number(line.quantity),
          unitPrice: Number(price),
          discount:
            line.discountType === 'percent'
              ? { kind: 'percent', rate: line.discountValue }
              : discount === 0n
                ? { kind: 'none' }
                : { kind: 'amount', minor: Number(discount) },
          taxCode: rateTaxCode(effectiveTaxRate),
        },
      ],
    }).lines[0];
  } catch (cause) {
    if (
      cause instanceof Error &&
      'code' in cause &&
      cause.code === 'DISCOUNT_EXCEEDS_GROSS'
    )
      return {
        valid: false,
        errors: { discountValue: 'discount-exceeds-gross' },
      };
    return { valid: false, errors: { taxRate: 'range' } };
  }
  return {
    valid: true,
    effectiveTaxRate,
    grossMinor: calculated.grossMinor,
    discountMinor: calculated.discountMinor,
    subtotalMinor: calculated.netMinor,
    taxMinor: calculated.taxMinor,
    totalMinor: calculated.netMinor + calculated.taxMinor,
  };
}

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000'))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/** Validate the header and sum validated lines without floating-point arithmetic. */
export function calculateInvoiceDraft(
  values: InvoiceDraftValues,
  options: InvoiceDraftCalculationOptions = {},
): InvoiceDraftCalculation {
  const errors: Partial<Record<InvoiceDraftField, InvoiceCalculationError>> =
    {};
  const roundingScope =
    options.roundingScope === undefined ? 'line' : options.roundingScope;
  if (roundingScope !== 'line' && roundingScope !== 'invoice')
    errors.roundingScope = 'invalid-mode';
  if (!values.customerId?.trim()) errors.customerId = 'required';
  if (!calendarDate(values.issuedOn)) errors.issuedOn = 'invalid-date';
  if (!calendarDate(values.dueOn) || values.dueOn < values.issuedOn)
    errors.dueOn = 'invalid-date';
  if (!/^[A-Z]{3}$/.test(values.currency)) errors.currency = 'invalid-currency';
  const inheritedRate = rate(values.taxRate);
  if (typeof inheritedRate === 'string') errors.taxRate = inheritedRate;
  if (values.lines.length === 0) errors.lines = 'required';
  if (
    new Set(values.lines.map((line) => line.key)).size !== values.lines.length
  )
    errors.lines = 'duplicate-key';
  const lineResults = values.lines.map((line) =>
    calculateInvoiceLine(line, {
      currency: values.currency,
      inheritedTaxRate: values.taxRate,
    }),
  );
  const sums = {
    grossMinor: 0n,
    discountMinor: 0n,
    subtotalMinor: 0n,
    taxMinor: 0n,
    totalMinor: 0n,
  };
  for (const result of lineResults) {
    if (!result.valid) continue;
    for (const key of Object.keys(sums) as Array<keyof typeof sums>)
      sums[key] += BigInt(result[key]);
  }
  if (
    roundingScope === 'invoice' &&
    !Object.keys(errors).length &&
    lineResults.every((result) => result.valid)
  ) {
    // Rates have already passed exact decimal validation. Normalize textual
    // equivalents without numeric conversion before assigning component IDs.
    const taxable = lineResults.map((result, index) => {
      if (!result.valid) throw new Error('Validated invoice line expected');
      const [whole, fraction = ''] = result.effectiveTaxRate.split('.');
      const digits = fraction.replace(/0+$/, '');
      const percent = `${BigInt(whole)}${digits ? `.${digits}` : ''}`;
      return {
        id: values.lines[index].key,
        amountMinor: result.subtotalMinor,
        category: percent,
      };
    });
    try {
      const calculated = calculateMoneyDocument({
        currency: values.currency,
        lineAmountType: 'exclusive',
        roundingScope: 'document',
        lines: taxable.map((row, index) => {
          const result = lineResults[index];
          if (!result.valid) throw new Error('Validated invoice line expected');
          return {
            id: row.id,
            quantity: 1,
            unitPrice: result.grossMinor,
            discount:
              result.discountMinor === 0
                ? ({ kind: 'none' } as const)
                : ({ kind: 'amount', minor: result.discountMinor } as const),
            taxCode: rateTaxCode(row.category),
          };
        }),
      });
      sums.taxMinor = BigInt(calculated.taxMinor);
      sums.totalMinor = sums.subtotalMinor + sums.taxMinor;
    } catch (cause) {
      if (
        !(cause instanceof RangeError || cause instanceof MoneyValidationError)
      )
        throw cause;
      errors.total = 'range';
    }
  }
  if (Object.values(sums).some((value) => value > MAX_MINOR))
    errors.total = 'range';
  if (Object.keys(errors).length || lineResults.some((result) => !result.valid))
    return { valid: false, errors, lineResults };
  return {
    valid: true,
    lineResults,
    grossMinor: Number(sums.grossMinor),
    discountMinor: Number(sums.discountMinor),
    subtotalMinor: Number(sums.subtotalMinor),
    taxMinor: Number(sums.taxMinor),
    totalMinor: Number(sums.totalMinor),
  };
}
