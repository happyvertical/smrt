/** A quotation received from a vendor is distinct from an estimate sent to a customer. */
export type QuoteDocumentKind = 'vendor-quotation' | 'customer-estimate';

/** Saved money: exact integer minor units and an explicit caller-owned scale. */
export interface QuoteMoneyMinor {
  /** ISO or application currency/asset code. */
  currency: string;
  /** Number of decimal places (0–8); never inferred from locale. */
  minorUnitDigits: number;
  /** Unknown pricing is null, never zero. */
  amountMinor: number | null;
}

/** Immutable revision summary supplied by the application's public adapter. */
export interface QuoteRevision {
  /** Stable identity. */
  id: string;
  /** Record domain; never infer from an amount or status. */
  kind: QuoteDocumentKind;
  /** Human revision identifier. */
  label: string;
  /** Caller-owned state label, including future/unknown states. */
  status: string;
  /** Commercial counterparty display name. */
  counterparty: string;
  /** Exact retained total. */
  total: QuoteMoneyMinor;
  /** Plain source date or formatted timestamp supplied by the caller. */
  recordedAt?: string;
  /** Human reason for this revision. */
  reason?: string;
  /** Scope retained in this revision. */
  scope?: string;
  /** Optional authorized application detail URL. */
  href?: string;
}

/** Unparsed form strings retain invalid input and currency precision on failure. */
export interface QuoteDraftLine {
  /** Caller-generated stable row identity, posted on every submit. */
  id: string;
  /** Original description, quantity and major-unit rate strings. */
  description: string;
  /** Empty when no unit breakdown was supplied. */
  quantity: string;
  /** Unparsed major-unit amount; server validates conversion to minor units. */
  unitRate: string;
}

/** Editable presentation values, not a persisted financial model. */
export interface QuoteDraftValues {
  /** Counterparty identity interpreted by the caller's adapter. */
  counterpartyId: string;
  /** Human document reference. */
  reference: string;
  /** Source received/issue date. */
  date: string;
  /** Optional expiry date. */
  validUntil: string;
  /** Currency code; server validates it. */
  currency: string;
  /** Unparsed major-unit total, including tax. */
  total: string;
  /** Unparsed major-unit tax included in total. */
  tax: string;
  /** Retained scope, inclusions and exclusions. */
  scope: string;
  /** Included work or items. */
  inclusions: string;
  /** Excluded work or items. */
  exclusions: string;
  /** Reason for the new revision. */
  reason: string;
  /** Source line evidence; no client-side pricing calculation. */
  lines: QuoteDraftLine[];
}

/** Field names can match an existing native form endpoint without renaming it. */
export type QuoteFieldNames = Record<
  | Exclude<keyof QuoteDraftValues, 'lines'>
  | 'lineId'
  | 'lineDescription'
  | 'lineQuantity'
  | 'lineUnitRate',
  string
>;

/** Defaults use repeated line fields for native FormData.getAll(). */
export const quoteFieldNames: QuoteFieldNames = {
  counterpartyId: 'counterpartyId',
  reference: 'reference',
  date: 'date',
  validUntil: 'validUntil',
  currency: 'currency',
  total: 'total',
  tax: 'tax',
  scope: 'scope',
  inclusions: 'inclusions',
  exclusions: 'exclusions',
  reason: 'reason',
  lineId: 'lineId',
  lineDescription: 'lineDescription',
  lineQuantity: 'lineQuantity',
  lineUnitRate: 'lineUnitRate',
};

/** Format exact saved values without silently rounding or guessing an asset scale. */
export function quoteMinorText(money: QuoteMoneyMinor): string | null {
  if (
    !Number.isInteger(money.minorUnitDigits) ||
    money.minorUnitDigits < 0 ||
    money.minorUnitDigits > 8
  )
    throw new RangeError(
      'Quote minorUnitDigits must be an integer from 0 to 8',
    );
  if (money.amountMinor === null) return null;
  if (!Number.isSafeInteger(money.amountMinor))
    throw new RangeError('Quote amountMinor must be a safe integer');
  const digits = money.minorUnitDigits;
  const negative = money.amountMinor < 0;
  const raw = BigInt(Math.abs(money.amountMinor))
    .toString()
    .padStart(digits + 1, '0');
  return `${negative ? '-' : ''}${digits ? `${raw.slice(0, -digits)}.${raw.slice(-digits)}` : raw}`;
}

/** Comparable revision delta; unknown or different currencies/scales/domains are not comparable. */
export function quoteRevisionDelta(
  previous: QuoteRevision,
  current: QuoteRevision,
): QuoteMoneyMinor | null {
  quoteMinorText(previous.total);
  quoteMinorText(current.total);
  if (
    previous.kind !== current.kind ||
    previous.total.currency !== current.total.currency ||
    previous.total.minorUnitDigits !== current.total.minorUnitDigits ||
    previous.total.amountMinor === null ||
    current.total.amountMinor === null
  )
    return null;
  const difference =
    BigInt(current.total.amountMinor) - BigInt(previous.total.amountMinor);
  if (
    difference > BigInt(Number.MAX_SAFE_INTEGER) ||
    difference < BigInt(Number.MIN_SAFE_INTEGER)
  )
    return null;
  return { ...current.total, amountMinor: Number(difference) };
}
