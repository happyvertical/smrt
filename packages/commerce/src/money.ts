/** Exact, transport-neutral commercial document money calculation. */

import { ISO_4217_MINOR_UNITS } from '@happyvertical/smrt-ui/currency';
import {
  allocateSignedRationals,
  roundSignedRational,
} from './money-rational.js';

/** Throw unless every named model value is a finite integer minor-unit amount. */
export function assertIntegerMinorUnits(
  context: string,
  label: string,
  entries: ReadonlyArray<readonly [string, number]>,
): void {
  for (const [field, value] of entries) {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(
        `${context} ${label}: ${field} must be an integer number of minor ` +
          `units (cents, satoshis) — got ${value}. Money is exact: $19.99 is ` +
          '1999, not 19.99.',
      );
    }
  }
}

export type LineAmountType = 'exclusive' | 'inclusive' | 'none';
export type TaxRoundingScope = 'line' | 'document';
export type TaxCodeKind = 'taxable' | 'zero-rated' | 'exempt' | 'out-of-scope';
export type TaxCodeAppliesTo = 'sales' | 'purchases' | 'both';

export type MoneyValidationCode =
  | 'DISCOUNT_BOTH_FORMS'
  | 'DISCOUNT_EXCEEDS_GROSS'
  | 'DISCOUNT_SIGN'
  | 'PERCENT_OUT_OF_RANGE'
  | 'COMPOUND_UNSUPPORTED'
  | 'INVALID_MONEY_INPUT'
  | 'TAX_CODE_DUPLICATE_COMPONENT'
  | 'TAX_CODE_KIND'
  | 'TAX_CODE_NON_TAXABLE_COMPONENTS'
  | 'TAX_CODE_NOT_FOUND'
  | 'TAX_CODE_TAXABLE_EMPTY'
  | 'TAX_COMPONENT_RATE_CONFLICT'
  | 'TAX_CODE_INACTIVE'
  | 'TAX_CODE_SCOPE'
  | 'UNSAFE_MONEY'
  | 'FROZEN_DOCUMENT'
  | 'CURRENCY_MISMATCH'
  | 'CREDIT_EXCEEDS_LINE'
  | 'CREDIT_TARGET_NOT_ISSUED';

/** Stable validation error shared by model, editor, and transport adapters. */
export class MoneyValidationError extends Error {
  override readonly name = 'MoneyValidationError';

  constructor(
    readonly code: MoneyValidationCode,
    message: string,
  ) {
    super(message);
  }
}

export interface TaxComponentInput {
  taxComponentId: string;
  /** Exact percent: "7" means 7%; at most six fractional digits. */
  percent: string;
  compound: boolean;
}

export interface MoneyTaxCodeInput {
  id: string;
  kind: TaxCodeKind;
  components: readonly TaxComponentInput[];
}

export interface ResolvableTaxCodeInput extends MoneyTaxCodeInput {
  active: boolean;
  appliesTo: TaxCodeAppliesTo;
}

export type MoneyDiscountInput =
  | { kind: 'none' }
  | { kind: 'percent'; rate: string }
  | { kind: 'amount'; minor: number };

export interface MoneyLineInput {
  id: string;
  /** Nonnegative decimal quantity with at most six fractional digits. */
  quantity: number;
  /** Signed safe integer minor units. */
  unitPrice: number;
  discount: MoneyDiscountInput;
  /** Explicit tax-exclusive basis for credit-note amount allocations. */
  netAmountMinor?: number;
  /** Null means no code resolved; `none` pricing requires an out-of-scope code. */
  taxCode: MoneyTaxCodeInput | null;
}

export interface MoneyLineResult {
  id: string;
  grossMinor: number;
  discountMinor: number;
  amountMinor: number;
  components: { taxComponentId: string; taxMinor: number }[];
  taxMinor: number;
  netMinor: number;
}

export interface MoneyDocumentTaxResult {
  /** Null records an unassigned line without inventing a persisted tax-code ID. */
  taxCodeId: string | null;
  taxComponentId: string | null;
  taxableMinor: number;
  taxMinor: number;
}

export interface MoneyDocumentResult {
  lines: MoneyLineResult[];
  subtotalMinor: number;
  discountTotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxes: MoneyDocumentTaxResult[];
}

export type TaxCodeResolutionSource =
  | 'line'
  | 'exempt-customer'
  | 'product'
  | 'customer'
  | 'app'
  | 'none';

export interface ResolveLineTaxCodeInput {
  lineAmountType: LineAmountType;
  lineOverride?: string | null;
}

export interface ResolveLineTaxCodeContext {
  direction: 'sales' | 'purchases';
  codes: Readonly<Record<string, ResolvableTaxCodeInput>>;
  customerTaxExempt: boolean;
  exemptCodeId?: string | null;
  productCodeId?: string | null;
  partyCodeId?: string | null;
  appDefaultCodeId?: string | null;
  outOfScopeCodeId?: string | null;
}

export interface ResolvedLineTaxCode {
  taxCode: ResolvableTaxCodeInput | null;
  source: TaxCodeResolutionSource;
}

const PERCENT_SCALE = 1_000_000n;
const PERCENT_DENOMINATOR = 100n * PERCENT_SCALE;
const MAX_SAFE_MONEY = BigInt(Number.MAX_SAFE_INTEGER);
const IDENTIFIER = /^\S(?:.*\S)?$/;

function validationError(code: MoneyValidationCode, message: string): never {
  throw new MoneyValidationError(code, message);
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || !IDENTIFIER.test(value))
    validationError(
      'INVALID_MONEY_INPUT',
      `${label} must be a nonempty string`,
    );
}

function safeMoney(value: bigint): number {
  if (value > MAX_SAFE_MONEY || value < -MAX_SAFE_MONEY)
    validationError('UNSAFE_MONEY', 'Money exceeds safe integer minor units');
  return Number(value);
}

function money(value: number): bigint {
  if (!Number.isSafeInteger(value))
    validationError('UNSAFE_MONEY', 'Money must be safe integer minor units');
  return BigInt(value);
}

interface ExactDecimal {
  coefficient: bigint;
  scale: bigint;
}

function numberDecimal(value: number, precision: number): ExactDecimal {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    validationError(
      'INVALID_MONEY_INPUT',
      'Quantity is outside the supported range',
    );
  const [mantissa, exponentText = '0'] = value.toString().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const places = fraction.length - Number(exponentText);
  if (places > precision)
    validationError(
      'INVALID_MONEY_INPUT',
      'Quantity exceeds the supported decimal precision',
    );
  const coefficient = BigInt(whole + fraction);
  return places < 0
    ? { coefficient: coefficient * 10n ** BigInt(-places), scale: 1n }
    : { coefficient, scale: 10n ** BigInt(places) };
}

function percentUnits(value: string): bigint {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(value)
  )
    validationError(
      'PERCENT_OUT_OF_RANGE',
      'Percent must be an exact decimal from 0 through 100 with at most six fractional digits',
    );
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * PERCENT_SCALE + BigInt(fraction.padEnd(6, '0'));
  if (units > PERCENT_DENOMINATOR)
    validationError('PERCENT_OUT_OF_RANGE', 'Percent exceeds 100');
  return units;
}

function validateTaxCode(
  code: MoneyTaxCodeInput,
  rates: Map<string, bigint>,
): { taxComponentId: string; rate: bigint }[] {
  if (!code || typeof code !== 'object')
    validationError('INVALID_MONEY_INPUT', 'Tax code must be an object');
  assertIdentifier(code.id, 'Tax code ID');
  if (
    code.kind !== 'taxable' &&
    code.kind !== 'zero-rated' &&
    code.kind !== 'exempt' &&
    code.kind !== 'out-of-scope'
  )
    validationError('TAX_CODE_KIND', 'Unknown tax code kind');
  if (!Array.isArray(code.components))
    validationError(
      'INVALID_MONEY_INPUT',
      'Tax code components must be an array',
    );
  if (code.kind === 'taxable' && code.components.length === 0)
    validationError(
      'TAX_CODE_TAXABLE_EMPTY',
      'Taxable codes require at least one component',
    );
  if (code.kind !== 'taxable' && code.components.length !== 0)
    validationError(
      'TAX_CODE_NON_TAXABLE_COMPONENTS',
      'Non-taxable codes cannot contain components',
    );
  const seen = new Set<string>();
  return code.components.map((component) => {
    if (!component || typeof component !== 'object')
      validationError('INVALID_MONEY_INPUT', 'Tax component must be an object');
    assertIdentifier(component.taxComponentId, 'Tax component ID');
    if (seen.has(component.taxComponentId))
      validationError(
        'TAX_CODE_DUPLICATE_COMPONENT',
        'Duplicate tax component within code',
      );
    seen.add(component.taxComponentId);
    if (typeof component.compound !== 'boolean')
      validationError(
        'INVALID_MONEY_INPUT',
        'Tax component compound must be boolean',
      );
    if (component.compound)
      validationError(
        'COMPOUND_UNSUPPORTED',
        'Compound tax components are not supported',
      );
    const rate = percentUnits(component.percent);
    const existing = rates.get(component.taxComponentId);
    if (existing !== undefined && existing !== rate)
      validationError(
        'TAX_COMPONENT_RATE_CONFLICT',
        'Shared tax component has conflicting percentages',
      );
    rates.set(component.taxComponentId, rate);
    return { taxComponentId: component.taxComponentId, rate };
  });
}

function discountFor(gross: bigint, discount: MoneyDiscountInput): bigint {
  if (!discount || typeof discount !== 'object')
    validationError('INVALID_MONEY_INPUT', 'Discount must be a tagged object');
  const runtime = discount as MoneyDiscountInput & {
    rate?: unknown;
    minor?: unknown;
  };
  if (runtime.rate !== undefined && runtime.minor !== undefined)
    validationError(
      'DISCOUNT_BOTH_FORMS',
      'A discount cannot include both percent and amount forms',
    );
  let result: bigint;
  if (discount.kind === 'none') {
    if (runtime.rate !== undefined || runtime.minor !== undefined)
      validationError(
        'DISCOUNT_BOTH_FORMS',
        'A none discount cannot include percent or amount values',
      );
    result = 0n;
  } else if (discount.kind === 'percent') {
    result = roundSignedRational(
      gross * percentUnits(discount.rate),
      PERCENT_DENOMINATOR,
    );
  } else if (discount.kind === 'amount') {
    result = money(discount.minor);
  } else {
    validationError('INVALID_MONEY_INPUT', 'Unknown discount kind');
  }
  if (result !== 0n && gross !== 0n && result < 0n !== gross < 0n)
    validationError(
      'DISCOUNT_SIGN',
      'Discount amount must carry the sign of gross',
    );
  if (gross === 0n && result !== 0n)
    validationError('DISCOUNT_SIGN', 'A zero gross cannot carry a discount');
  const magnitude = (value: bigint) => (value < 0n ? -value : value);
  if (magnitude(result) > magnitude(gross))
    validationError('DISCOUNT_EXCEEDS_GROSS', 'Discount cannot exceed gross');
  return result;
}

function validateDocumentInput(input: {
  currency: string;
  lineAmountType: LineAmountType;
  roundingScope: TaxRoundingScope;
  lines: readonly MoneyLineInput[];
}): void {
  if (!input || typeof input !== 'object')
    validationError('INVALID_MONEY_INPUT', 'Money input must be an object');
  if (
    typeof input.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    !ISO_4217_MINOR_UNITS.has(input.currency) ||
    ISO_4217_MINOR_UNITS.get(input.currency) === null
  )
    validationError(
      'CURRENCY_MISMATCH',
      'Currency must be a supported uppercase ISO 4217 code with minor units',
    );
  if (
    input.lineAmountType !== 'exclusive' &&
    input.lineAmountType !== 'inclusive' &&
    input.lineAmountType !== 'none'
  )
    validationError('INVALID_MONEY_INPUT', 'Unknown line amount type');
  if (input.roundingScope !== 'line' && input.roundingScope !== 'document')
    validationError('INVALID_MONEY_INPUT', 'Unknown tax rounding scope');
  if (!Array.isArray(input.lines))
    validationError('INVALID_MONEY_INPUT', 'Lines must be an array');
}

/** Calculate exact line amounts, per-component tax, and document totals. */
export function calculateMoneyDocument(input: {
  currency: string;
  lineAmountType: LineAmountType;
  roundingScope: TaxRoundingScope;
  lines: readonly MoneyLineInput[];
}): MoneyDocumentResult {
  validateDocumentInput(input);
  const ids = new Set<string>();
  const rates = new Map<string, bigint>();
  const working = input.lines.map((line) => {
    if (!line || typeof line !== 'object')
      validationError('INVALID_MONEY_INPUT', 'Money line must be an object');
    assertIdentifier(line.id, 'Line ID');
    if (ids.has(line.id))
      validationError('INVALID_MONEY_INPUT', 'Duplicate money line ID');
    ids.add(line.id);
    const explicitNet =
      line.netAmountMinor === undefined ? null : money(line.netAmountMinor);
    const quantity = numberDecimal(line.quantity, 6);
    const gross =
      explicitNet ??
      roundSignedRational(
        quantity.coefficient * money(line.unitPrice),
        quantity.scale,
      );
    safeMoney(gross);
    const discount =
      explicitNet === null ? discountFor(gross, line.discount) : 0n;
    const amount = gross - discount;
    safeMoney(amount);
    if (input.lineAmountType === 'none' && !line.taxCode)
      validationError(
        'TAX_CODE_NOT_FOUND',
        'None pricing requires an out-of-scope tax code',
      );
    if (
      input.lineAmountType === 'none' &&
      line.taxCode?.kind !== 'out-of-scope'
    )
      validationError(
        'TAX_CODE_KIND',
        'None pricing requires an out-of-scope tax code',
      );
    const components = line.taxCode ? validateTaxCode(line.taxCode, rates) : [];
    const totalRate = components.reduce(
      (sum, component) => sum + component.rate,
      0n,
    );
    const denominator =
      explicitNet === null && input.lineAmountType === 'inclusive'
        ? PERCENT_DENOMINATOR + totalRate
        : PERCENT_DENOMINATOR;
    return {
      input: line,
      gross,
      discount,
      amount,
      explicitNet,
      exact:
        input.lineAmountType === 'none'
          ? []
          : components.map((component) => ({
              taxComponentId: component.taxComponentId,
              numerator: amount * component.rate,
              denominator,
            })),
      taxes: new Map<string, bigint>(),
    };
  });

  if (input.roundingScope === 'line') {
    for (const line of working)
      for (const component of line.exact)
        line.taxes.set(
          component.taxComponentId,
          roundSignedRational(component.numerator, component.denominator),
        );
  } else {
    for (const componentId of [...rates.keys()].sort()) {
      const eligible = working.flatMap((line) => {
        const exact = line.exact.find(
          (component) => component.taxComponentId === componentId,
        );
        return exact ? [{ line, exact }] : [];
      });
      const allocated = allocateSignedRationals(
        eligible.map(({ line, exact }) => ({
          id: line.input.id,
          numerator: exact.numerator,
          denominator: exact.denominator,
        })),
      );
      for (const allocation of allocated.allocations)
        eligible
          .find(({ line }) => line.input.id === allocation.id)
          ?.line.taxes.set(componentId, allocation.value);
    }
  }

  const lines = working.map((line): MoneyLineResult => {
    const components = line.exact.map((component) => ({
      taxComponentId: component.taxComponentId,
      taxMinor: safeMoney(line.taxes.get(component.taxComponentId) ?? 0n),
    }));
    const tax = components.reduce(
      (sum, component) => sum + BigInt(component.taxMinor),
      0n,
    );
    const net =
      line.explicitNet ??
      (input.lineAmountType === 'inclusive' ? line.amount - tax : line.amount);
    const amount =
      line.explicitNet !== null && input.lineAmountType === 'inclusive'
        ? net + tax
        : line.amount;
    return {
      id: line.input.id,
      grossMinor: safeMoney(line.gross),
      discountMinor: safeMoney(line.discount),
      amountMinor: safeMoney(amount),
      components,
      taxMinor: safeMoney(tax),
      netMinor: safeMoney(net),
    };
  });

  const taxRows = new Map<string, MoneyDocumentTaxResult>();
  for (let index = 0; index < working.length; index++) {
    const source = working[index].input;
    const result = lines[index];
    if (
      !source.taxCode ||
      source.taxCode.components.length === 0 ||
      input.lineAmountType === 'none'
    ) {
      const key = `${source.taxCode?.id ?? ''}\u0000`;
      const row = taxRows.get(key) ?? {
        taxCodeId: source.taxCode?.id ?? null,
        taxComponentId: null,
        taxableMinor: 0,
        taxMinor: 0,
      };
      row.taxableMinor = safeMoney(
        BigInt(row.taxableMinor) + BigInt(result.netMinor),
      );
      taxRows.set(key, row);
      continue;
    }
    for (const component of result.components) {
      if (!source.taxCode)
        validationError(
          'INVALID_MONEY_INPUT',
          'Tax component requires a tax code',
        );
      const key = `${source.taxCode.id}\u0000${component.taxComponentId}`;
      const row = taxRows.get(key) ?? {
        taxCodeId: source.taxCode.id,
        taxComponentId: component.taxComponentId,
        taxableMinor: 0,
        taxMinor: 0,
      };
      row.taxableMinor = safeMoney(
        BigInt(row.taxableMinor) + BigInt(result.netMinor),
      );
      row.taxMinor = safeMoney(
        BigInt(row.taxMinor) + BigInt(component.taxMinor),
      );
      taxRows.set(key, row);
    }
  }
  const taxes = [...taxRows.values()].sort((left, right) => {
    const leftCode = left.taxCodeId ?? '';
    const rightCode = right.taxCodeId ?? '';
    if (leftCode !== rightCode) return leftCode < rightCode ? -1 : 1;
    const leftComponent = left.taxComponentId ?? '';
    const rightComponent = right.taxComponentId ?? '';
    return leftComponent < rightComponent
      ? -1
      : leftComponent > rightComponent
        ? 1
        : 0;
  });
  const subtotal = lines.reduce((sum, line) => sum + BigInt(line.netMinor), 0n);
  const discountTotal = lines.reduce(
    (sum, line) => sum + BigInt(line.discountMinor),
    0n,
  );
  const tax = lines.reduce((sum, line) => sum + BigInt(line.taxMinor), 0n);
  return {
    lines,
    subtotalMinor: safeMoney(subtotal),
    discountTotalMinor: safeMoney(discountTotal),
    taxMinor: safeMoney(tax),
    totalMinor: safeMoney(subtotal + tax),
    taxes,
  };
}

function selectedCode(
  id: string | null | undefined,
  source: TaxCodeResolutionSource,
  context: ResolveLineTaxCodeContext,
): ResolvedLineTaxCode | null {
  if (!id) return null;
  const taxCode = context.codes[id];
  if (!taxCode)
    validationError('TAX_CODE_NOT_FOUND', `Unknown tax code: ${id}`);
  if (typeof taxCode.active !== 'boolean')
    validationError('INVALID_MONEY_INPUT', `Tax code ${id} has invalid state`);
  if (!taxCode.active)
    validationError('TAX_CODE_INACTIVE', `Tax code ${id} is inactive`);
  if (
    taxCode.appliesTo !== 'sales' &&
    taxCode.appliesTo !== 'purchases' &&
    taxCode.appliesTo !== 'both'
  )
    validationError(
      'INVALID_MONEY_INPUT',
      `Tax code ${id} has invalid applicability`,
    );
  if (taxCode.appliesTo !== 'both' && taxCode.appliesTo !== context.direction)
    validationError(
      'TAX_CODE_SCOPE',
      `Tax code ${id} does not apply to ${context.direction}`,
    );
  return { taxCode, source };
}

/** Resolve a line tax code from already-loaded values, without model or I/O access. */
export function resolveLineTaxCode(
  line: ResolveLineTaxCodeInput,
  context: ResolveLineTaxCodeContext,
): ResolvedLineTaxCode {
  if (
    !line ||
    typeof line !== 'object' ||
    !context ||
    typeof context !== 'object'
  )
    validationError(
      'INVALID_MONEY_INPUT',
      'Tax-code resolution inputs must be objects',
    );
  if (!context.codes || typeof context.codes !== 'object')
    validationError('INVALID_MONEY_INPUT', 'Tax-code map must be an object');
  if (
    line.lineAmountType !== 'exclusive' &&
    line.lineAmountType !== 'inclusive' &&
    line.lineAmountType !== 'none'
  )
    validationError('INVALID_MONEY_INPUT', 'Unknown line amount type');
  if (context.direction !== 'sales' && context.direction !== 'purchases')
    validationError('INVALID_MONEY_INPUT', 'Unknown tax-code direction');
  if (line.lineAmountType === 'none') {
    if (!context.outOfScopeCodeId)
      validationError(
        'TAX_CODE_NOT_FOUND',
        'None mode requires an out-of-scope tax code',
      );
    const resolved = selectedCode(context.outOfScopeCodeId, 'none', context);
    if (resolved?.taxCode?.kind !== 'out-of-scope')
      validationError(
        'TAX_CODE_KIND',
        'None mode requires an out-of-scope tax code',
      );
    return resolved;
  }
  if (context.customerTaxExempt && !line.lineOverride) {
    if (!context.exemptCodeId)
      validationError(
        'TAX_CODE_NOT_FOUND',
        'An exempt customer requires an exempt tax code',
      );
    const exempt = selectedCode(
      context.exemptCodeId,
      'exempt-customer',
      context,
    );
    if (exempt?.taxCode?.kind !== 'exempt')
      validationError(
        'TAX_CODE_KIND',
        'Customer exemption requires an exempt tax code',
      );
    return exempt;
  }
  const candidates: readonly [
    string | null | undefined,
    TaxCodeResolutionSource,
  ][] = [
    [line.lineOverride, 'line'],
    [context.productCodeId, 'product'],
    [context.partyCodeId, 'customer'],
    [context.appDefaultCodeId, 'app'],
  ];
  for (const [id, source] of candidates) {
    const resolved = selectedCode(id, source, context);
    if (resolved) return resolved;
  }
  return { taxCode: null, source: 'none' };
}
