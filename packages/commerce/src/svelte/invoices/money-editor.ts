/** Typed UI adapter for the v2 commercial-money editor. It never writes models. */
import {
  calculateMoneyDocument,
  type LineAmountType,
  type MoneyDiscountInput,
  type MoneyDocumentResult,
  type MoneyTaxCodeInput,
  type MoneyValidationCode,
  type TaxRoundingScope,
} from '../../money.js';
import { currencyMinorUnitExponent } from './currency.js';

export interface MoneyEditorTaxCode extends MoneyTaxCodeInput {
  /** Stable label stored with the code supplied by the authorized adapter. */
  code: string;
  name?: string;
  /** Stored component labels; a component can be shared by more than one code. */
  componentNames?: Readonly<Record<string, string>>;
}

export interface MoneyEditorLineDraft {
  id: string;
  description: string;
  quantity: string;
  /** Major-unit text, retained without coercion after an invalid submission. */
  unitPrice: string;
  discountType: 'none' | 'percent' | 'amount';
  /** A non-negative magnitude; the calculator applies the line sign. */
  discountValue: string;
  taxMode: 'inherit' | 'override';
  /** Blank is inherit. Historical rows may retain unknown code IDs. */
  taxCodeId?: string | null;
  /** Resolver result to use while the line remains inherited. */
  inheritedTaxCodeId?: string | null;
  inheritedTaxCodeSource?:
    | 'product'
    | 'customer'
    | 'app'
    | 'exempt-customer'
    | 'none';
}

export interface MoneyEditorDraft {
  currency: string;
  lineAmountType: LineAmountType;
  roundingScope: TaxRoundingScope;
  lines: readonly MoneyEditorLineDraft[];
}

export interface MoneyStoredTax {
  id: string;
  /** Shared component identity: repeated tax codes with this ID aggregate. */
  taxComponentId?: string | null;
  name: string;
  percent: string;
  taxableMinor: number;
  taxMinor: number;
}

/** A frozen document is rendered solely from this server-authoritative snapshot. */
export interface MoneyStoredDocument {
  lineAmountType: LineAmountType;
  roundingScope: TaxRoundingScope;
  subtotalMinor: number;
  discountTotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxes: readonly MoneyStoredTax[];
}
/** Stored money facts that header-only quote and purchase editors can display. */
export interface MoneyHeaderDisplay {
  lineAmountType: LineAmountType;
  taxMinor: number;
  totalMinor: number;
  minorUnitDigits: number;
}

export interface MoneyEditorFieldNames {
  lineAmountType: string;
  roundingScope: string;
  lineId: string;
  lineDescription: string;
  lineQuantity: string;
  lineUnitPrice: string;
  lineDiscountType: string;
  lineDiscountValue: string;
  lineTaxMode: string;
  lineTaxCodeId: string;
}

export const moneyEditorFieldNames: MoneyEditorFieldNames = {
  lineAmountType: 'lineAmountType',
  roundingScope: 'taxRoundingScope',
  lineId: 'lineId',
  lineDescription: 'lineDescription',
  lineQuantity: 'lineQuantity',
  lineUnitPrice: 'lineUnitPrice',
  lineDiscountType: 'lineDiscountType',
  lineDiscountValue: 'lineDiscountValue',
  lineTaxMode: 'lineTaxMode',
  lineTaxCodeId: 'lineTaxCodeId',
};

export interface MoneyEditorProps {
  /** Explicit opt-in: existing invoice-editor consumers continue using legacy UI. */
  mode: 'v2';
  draft: MoneyEditorDraft;
  taxCodes: readonly MoneyEditorTaxCode[];
  /** Issued and posted documents must supply stored values and are read-only. */
  frozen?: boolean;
  status?: string;
  stored?: MoneyStoredDocument;
  customerTaxExempt?: boolean;
  sellerTaxRegistrations?: readonly string[];
  partyTaxId?: string | null;
  showNetSubtotal?: boolean;
  names?: Partial<MoneyEditorFieldNames>;
}

export type MoneyEditorCalculation =
  | { valid: true; result: MoneyDocumentResult }
  | {
      valid: false;
      code: MoneyValidationCode | 'INVALID_EDITOR_INPUT';
      message: string;
    };

function minor(text: string, exponent: number): number {
  if (!/^\d+(?:\.\d+)?$/u.test(text))
    throw new Error('Amounts must be non-negative decimal text.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > exponent)
    throw new Error('Amount exceeds the currency minor-unit precision.');
  const value = BigInt(whole + fraction.padEnd(exponent, '0'));
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Amount exceeds safe integer minor units.');
  return Number(value);
}

function quantity(text: string): number {
  if (!/^\d+(?:\.\d+)?$/u.test(text))
    throw new Error('Quantity must be a non-negative decimal.');
  return Number(text);
}

function discount(
  line: MoneyEditorLineDraft,
  exponent: number,
): MoneyDiscountInput {
  if (line.discountType === 'none') return { kind: 'none' };
  if (line.discountType === 'percent')
    return { kind: 'percent', rate: line.discountValue };
  return { kind: 'amount', minor: minor(line.discountValue, exponent) };
}

/**
 * Converts retained form text into the calculator's exact input. This is the
 * only calculation boundary used by the v2 editor; server adapters still
 * revalidate the resulting native form submission.
 */
export function calculateMoneyEditorDraft(
  draft: MoneyEditorDraft,
  taxCodes: readonly MoneyEditorTaxCode[],
): MoneyEditorCalculation {
  try {
    const codes = new Map(taxCodes.map((code) => [code.id, code]));
    const exponent = currencyMinorUnitExponent(draft.currency);
    const lines = draft.lines.map((line) => {
      const codeId =
        line.taxMode === 'override' ? line.taxCodeId : line.inheritedTaxCodeId;
      const taxCode = codeId ? (codes.get(codeId) ?? null) : null;
      if (codeId && !taxCode)
        throw new Error('The selected tax code is no longer available.');
      return {
        id: line.id,
        quantity: quantity(line.quantity),
        unitPrice: minor(line.unitPrice, exponent),
        discount: discount(line, exponent),
        taxCode,
      };
    });
    return {
      valid: true,
      result: calculateMoneyDocument({
        currency: draft.currency,
        lineAmountType: draft.lineAmountType,
        roundingScope: draft.roundingScope,
        lines,
      }),
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error)
      return {
        valid: false,
        code: (error as { code: MoneyValidationCode }).code,
        message:
          error instanceof Error ? error.message : 'Money validation failed.',
      };
    return {
      valid: false,
      code: 'INVALID_EDITOR_INPUT',
      message:
        error instanceof Error ? error.message : 'Money validation failed.',
    };
  }
}

/** Typed, calculation-free shape represented by the v2 editor's native controls. */
export function moneyEditorSubmission(draft: MoneyEditorDraft) {
  return {
    lineAmountType: draft.lineAmountType,
    taxRoundingScope: draft.roundingScope,
    lines: draft.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discountValue: line.discountValue,
      taxMode: line.taxMode,
      taxCodeId: line.taxCodeId ?? '',
    })),
  };
}
