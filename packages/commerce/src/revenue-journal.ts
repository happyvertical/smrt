/** Pure journal-entry construction from frozen commercial money snapshots. */

import { ISO_4217_MINOR_UNITS } from '@happyvertical/smrt-ui/currency';
import { MoneyValidationError } from './money.js';

const MAX_SAFE_MONEY = BigInt(Number.MAX_SAFE_INTEGER);

export interface RevenueJournalDocumentInput {
  id: string;
  number?: string | null;
  currency: string;
  lineAmountType: 'exclusive' | 'inclusive' | 'none';
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  providerTaxMinor: number;
}

export interface RevenueJournalLineInput {
  id: string;
  /** Stored gross-for-inclusive or net-for-exclusive line amount. */
  amountMinor: number;
  /** Stored total line tax, excluding document-level provider tax. */
  taxMinor: number;
  revenueAccountId?: string | null;
}

/** Stored DocumentTax snapshot fields used by revenue posting. */
export interface RevenueJournalTaxInput {
  currency: string;
  taxCodeId: string | null;
  taxCodeCode: string | null;
  taxComponentId: string | null;
  liabilityAccountId: string | null;
  taxMinor: number;
}

export interface RevenueJournalOptions {
  arAccountId: string;
  revenueAccountId: string;
  taxAccountId?: string | null;
  /** Explicit ledger book currency; conversion is outside this helper. */
  bookCurrency: string;
  /** Use -1 for an exact reversal or credit direction. */
  direction?: 1 | -1;
}

export interface RevenueJournalEntry {
  accountId: string;
  debit?: number;
  credit?: number;
  currency: string;
  memo: string;
}

export interface RevenueJournalResult {
  entries: RevenueJournalEntry[];
}

function fail(
  code: 'INVALID_MONEY_INPUT' | 'UNSAFE_MONEY' | 'CURRENCY_MISMATCH',
  message: string,
): never {
  throw new MoneyValidationError(code, message);
}

function identifier(value: string | null | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    fail('INVALID_MONEY_INPUT', `${label} must be a nonempty value`);
  return value;
}

function money(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value))
    fail('UNSAFE_MONEY', `${label} must be safe integer minor units`);
  return BigInt(value);
}

function safe(value: bigint, label: string): number {
  if (value > MAX_SAFE_MONEY || value < -MAX_SAFE_MONEY)
    fail('UNSAFE_MONEY', `${label} exceeds safe integer minor units`);
  return Number(value);
}

function currency(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value !== value.toUpperCase() ||
    !ISO_4217_MINOR_UNITS.has(value) ||
    ISO_4217_MINOR_UNITS.get(value) === null
  ) {
    fail('INVALID_MONEY_INPUT', `${label} must be a supported ISO 4217 code`);
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function add(group: Map<string, bigint>, key: string, value: bigint): void {
  group.set(key, (group.get(key) ?? 0n) + value);
}

function entry(
  accountId: string,
  movement: bigint,
  documentCurrency: string,
  memo: string,
): RevenueJournalEntry | null {
  if (movement === 0n) return null;
  const amount = safe(movement < 0n ? -movement : movement, 'Journal entry');
  return movement > 0n
    ? { accountId, debit: amount, currency: documentCurrency, memo }
    : { accountId, credit: amount, currency: documentCurrency, memo };
}

/**
 * Build balanced entries from persisted values only. Positive source amounts
 * debit receivables and credit revenue/tax; direction -1 swaps those sides.
 */
export function buildRevenueJournalEntries(
  document: RevenueJournalDocumentInput,
  lines: readonly RevenueJournalLineInput[],
  taxes: readonly RevenueJournalTaxInput[],
  options: RevenueJournalOptions,
): RevenueJournalResult {
  identifier(document.id, 'Document ID');
  const documentCurrency = currency(document.currency, 'Document currency');
  const bookCurrency = currency(options.bookCurrency, 'Book currency');
  if (documentCurrency !== bookCurrency)
    fail(
      'CURRENCY_MISMATCH',
      `Document currency ${documentCurrency} does not match book currency ${bookCurrency}`,
    );
  if (
    document.lineAmountType !== 'exclusive' &&
    document.lineAmountType !== 'inclusive' &&
    document.lineAmountType !== 'none'
  ) {
    fail('INVALID_MONEY_INPUT', 'Unknown line amount type');
  }
  if (
    options.direction !== undefined &&
    options.direction !== 1 &&
    options.direction !== -1
  )
    fail('INVALID_MONEY_INPUT', 'Journal direction must be 1 or -1');
  const direction = BigInt(options.direction ?? 1);
  const arAccountId = identifier(options.arAccountId, 'AR account ID');
  const fallbackRevenue = identifier(
    options.revenueAccountId,
    'Revenue account ID',
  );
  const fallbackTax = options.taxAccountId ?? null;
  if (fallbackTax !== null) identifier(fallbackTax, 'Tax account ID');

  const subtotal = money(document.subtotalMinor, 'Document subtotal');
  const documentTax = money(document.taxMinor, 'Document tax');
  const total = money(document.totalMinor, 'Document total');
  const providerTax = money(document.providerTaxMinor, 'Provider tax');
  if (subtotal + documentTax !== total)
    fail('INVALID_MONEY_INPUT', 'Document subtotal plus tax must equal total');

  const revenueGroups = new Map<string, bigint>();
  const lineIds = new Set<string>();
  let lineNetTotal = 0n;
  let lineTaxTotal = 0n;
  for (const line of lines) {
    const lineId = identifier(line.id, 'Line ID');
    if (lineIds.has(lineId))
      fail('INVALID_MONEY_INPUT', `Duplicate line ID: ${lineId}`);
    lineIds.add(lineId);
    const amount = money(line.amountMinor, `Line ${lineId} amount`);
    const tax = money(line.taxMinor, `Line ${lineId} tax`);
    const net = document.lineAmountType === 'inclusive' ? amount - tax : amount;
    const accountId = line.revenueAccountId
      ? identifier(line.revenueAccountId, `Line ${lineId} revenue account ID`)
      : fallbackRevenue;
    add(revenueGroups, accountId, net);
    lineNetTotal += net;
    lineTaxTotal += tax;
  }
  if (lineNetTotal !== subtotal)
    fail(
      'INVALID_MONEY_INPUT',
      'Stored line net total does not match document subtotal',
    );
  if (lineTaxTotal + providerTax !== documentTax)
    fail(
      'INVALID_MONEY_INPUT',
      'Stored line tax plus provider tax does not match document tax',
    );

  const taxGroups = new Map<string, bigint>();
  const taxRowIds = new Set<string>();
  let componentTaxTotal = 0n;
  for (const row of taxes) {
    if (currency(row.currency, 'DocumentTax currency') !== documentCurrency)
      fail(
        'CURRENCY_MISMATCH',
        'DocumentTax currency does not match document currency',
      );
    const tax = money(row.taxMinor, 'DocumentTax tax');
    if (tax === 0n) continue;
    if (row.taxComponentId === null)
      fail(
        'INVALID_MONEY_INPUT',
        'A nonzero DocumentTax row requires a component',
      );
    const componentId = identifier(row.taxComponentId, 'Tax component ID');
    const taxCodeId = identifier(row.taxCodeId, 'Tax code ID');
    identifier(row.taxCodeCode, 'Tax code code');
    const taxRowId = `${taxCodeId}\0${componentId}`;
    if (taxRowIds.has(taxRowId))
      fail(
        'INVALID_MONEY_INPUT',
        `Duplicate DocumentTax code/component row: ${taxCodeId}/${componentId}`,
      );
    taxRowIds.add(taxRowId);
    const accountId = row.liabilityAccountId
      ? identifier(row.liabilityAccountId, 'Tax liability account ID')
      : fallbackTax;
    if (accountId === null)
      fail(
        'INVALID_MONEY_INPUT',
        `Tax component ${componentId} has no posting account`,
      );
    add(taxGroups, accountId, tax);
    componentTaxTotal += tax;
  }
  if (componentTaxTotal !== lineTaxTotal)
    fail(
      'INVALID_MONEY_INPUT',
      'Stored component tax does not match stored line tax',
    );
  if (providerTax !== 0n && fallbackTax === null)
    fail('INVALID_MONEY_INPUT', 'Provider tax requires a fallback tax account');

  const label = document.number ?? document.id;
  const entries: RevenueJournalEntry[] = [];
  const ar = entry(
    arAccountId,
    total * direction,
    documentCurrency,
    `Receivable: ${label}`,
  );
  if (ar) entries.push(ar);
  for (const [accountId, amount] of [...revenueGroups].sort(([a], [b]) =>
    compareCodeUnits(a, b),
  )) {
    const built = entry(
      accountId,
      -amount * direction,
      documentCurrency,
      `Revenue: ${label}`,
    );
    if (built) entries.push(built);
  }
  for (const [accountId, amount] of [...taxGroups].sort(([a], [b]) =>
    compareCodeUnits(a, b),
  )) {
    const built = entry(
      accountId,
      -amount * direction,
      documentCurrency,
      `Tax: ${label}`,
    );
    if (built) entries.push(built);
  }
  if (providerTax !== 0n) {
    const built = entry(
      fallbackTax as string,
      -providerTax * direction,
      documentCurrency,
      `Provider tax: ${label}`,
    );
    if (built) entries.push(built);
  }

  let debits = 0n;
  let credits = 0n;
  for (const built of entries) {
    debits += BigInt(built.debit ?? 0);
    credits += BigInt(built.credit ?? 0);
  }
  if (debits !== credits)
    fail('INVALID_MONEY_INPUT', 'Built journal entries are not balanced');
  safe(debits, 'Journal debit total');
  return { entries };
}
