/** Exact, transport-neutral invoice line calculation shared by browser and server. */
import {
  calculateMoneyDocument,
  type MoneyLineResult,
  type MoneyTaxCodeInput,
  MoneyValidationError,
} from '../../money.js';

/** All monetary outputs are safe integer minor units. */
export interface InvoiceCalculatedAmounts {
  /** Rounded quantity times unit price before discounts. */
  grossMinor: number;
  /** Discount in minor units before tax; it carries the gross sign. */
  discountMinor: number;
  /** Gross less discount. */
  subtotalMinor: number;
  /** Rounded tax on the discounted subtotal. */
  taxMinor: number;
  /** Subtotal plus tax. */
  totalMinor: number;
}

interface Decimal {
  coefficient: bigint;
  scale: bigint;
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
