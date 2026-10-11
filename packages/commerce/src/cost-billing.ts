/** Exact, transport-neutral cost pricing. All money is signed integer minor units. */
export type CostBillingMode =
  | 'reimbursement-plus-fee'
  | 'fee-only'
  | 'nonbillable'
  | 'fixed-contract';

/** Caller-defined precedence, most specific first. No industry hierarchy is assumed. */
export interface CostMarkupOverride {
  source: string;
  policy?: string;
  version?: string;
  /** Exact percent in [0, 100000], with at most six decimal places. */
  percent?: string;
}

/** Detached provenance suitable for the caller's accepted pricing snapshot. */
export interface ResolvedCostMarkup {
  percent: string;
  selectedIndex: number;
  overrides: CostMarkupOverride[];
}

const SCALE = 1000000n;
const DENOMINATOR = 100n * SCALE;
const LIMIT = BigInt(Number.MAX_SAFE_INTEGER);

function percentUnits(value: string): bigint {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(value)
  ) {
    throw new TypeError(
      'Percent must be an exact decimal string with at most six decimal places',
    );
  }
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  if (units > 100000n * SCALE) throw new RangeError('Percent exceeds 100000');
  return units;
}

function money(value: number): bigint {
  if (!Number.isSafeInteger(value))
    throw new RangeError('Money must be safe integer minor units');
  return BigInt(value);
}

function safe(value: bigint): number {
  if (value > LIMIT || value < -LIMIT)
    throw new RangeError('Calculated money exceeds safe integer minor units');
  return Number(value);
}

function rounded(numerator: bigint): bigint {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const result = (magnitude + DENOMINATOR / 2n) / DENOMINATOR;
  return numerator < 0n ? -result : result;
}

function identifier(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new TypeError('Identifiers must be nonempty strings');
}

/** Select the first supplied percent, validating even shadowed overrides. */
export function resolveCostMarkup(
  overrides: readonly CostMarkupOverride[],
): ResolvedCostMarkup {
  let selectedIndex = -1;
  const copy = overrides.map((override, index) => {
    identifier(override.source);
    if (override.policy !== undefined) identifier(override.policy);
    if (override.version !== undefined) identifier(override.version);
    if (override.percent !== undefined) {
      percentUnits(override.percent);
      if (selectedIndex === -1) selectedIndex = index;
    }
    return { ...override };
  });
  if (selectedIndex === -1)
    throw new TypeError('An explicit markup percent is required');
  return {
    percent: copy[selectedIndex].percent as string,
    selectedIndex,
    overrides: copy,
  };
}

/** Calculate an explicitly supplied basis; this never reprices persisted snapshots. */
export function calculateCostBilling(input: {
  basisMinor: number;
  mode: CostBillingMode;
  markup: ResolvedCostMarkup;
}): {
  principalMinor: number;
  feeMinor: number;
  totalMinor: number;
  markup: ResolvedCostMarkup;
} {
  const basis = money(input.basisMinor);
  const markup = resolveCostMarkup(input.markup.overrides);
  if (
    markup.percent !== input.markup.percent ||
    markup.selectedIndex !== input.markup.selectedIndex
  ) {
    throw new TypeError('Resolved markup does not match its provenance');
  }
  let principal = 0n;
  let fee = 0n;
  switch (input.mode) {
    case 'reimbursement-plus-fee':
      principal = basis;
      fee = rounded(basis * percentUnits(markup.percent));
      break;
    case 'fee-only':
      fee = rounded(basis * percentUnits(markup.percent));
      break;
    case 'nonbillable':
    case 'fixed-contract':
      break;
    default:
      throw new TypeError('Unknown cost billing mode');
  }
  return {
    principalMinor: safe(principal),
    feeMinor: safe(fee),
    totalMinor: safe(principal + fee),
    markup,
  };
}

/** Explicit noncompounding tax components; an empty array means tax exempt. */
export interface CostBillingTaxRule {
  category: string;
  components: readonly { id: string; percent: string }[];
}

/**
 * Tax signed amounts with half-away-from-zero rounding. Invoice scope rounds each
 * component once after aggregation; line scope rounds each line/component pair.
 * A shared component ID must have the same exact rate across categories.
 */
export function calculateCostBillingTax(input: {
  lines: readonly { id: string; amountMinor: number; category: string }[];
  rules: readonly CostBillingTaxRule[];
  roundingScope: 'line' | 'invoice';
}): { taxMinor: number; components: { id: string; taxMinor: number }[] } {
  if (input.roundingScope !== 'line' && input.roundingScope !== 'invoice') {
    throw new TypeError('Unknown tax rounding scope');
  }
  const categories = new Map<string, { id: string; rate: bigint }[]>();
  const rates = new Map<string, bigint>();
  const totals = new Map<string, bigint>();
  for (const rule of input.rules) {
    identifier(rule.category);
    if (categories.has(rule.category))
      throw new TypeError('Duplicate tax category');
    const seen = new Set<string>();
    const components = rule.components.map((component) => {
      identifier(component.id);
      const rate = percentUnits(component.percent);
      if (seen.has(component.id))
        throw new TypeError('Duplicate tax component');
      if (rates.has(component.id) && rates.get(component.id) !== rate)
        throw new TypeError('Conflicting tax component rate');
      seen.add(component.id);
      rates.set(component.id, rate);
      return { id: component.id, rate };
    });
    categories.set(rule.category, components);
  }
  const ids = new Set<string>();
  for (const line of input.lines) {
    identifier(line.id);
    identifier(line.category);
    if (ids.has(line.id)) throw new TypeError('Duplicate tax line');
    ids.add(line.id);
    const amount = money(line.amountMinor);
    const components = categories.get(line.category);
    if (!components)
      throw new TypeError('Missing explicit tax category mapping');
    for (const component of components) {
      const numerator = amount * component.rate;
      const tax =
        input.roundingScope === 'line' ? rounded(numerator) : numerator;
      totals.set(component.id, (totals.get(component.id) ?? 0n) + tax);
    }
  }
  let total = 0n;
  const components = Array.from(totals, ([id, value]) => {
    const tax = input.roundingScope === 'invoice' ? rounded(value) : value;
    total += tax;
    return { id, taxMinor: safe(tax) };
  });
  return { taxMinor: safe(total), components };
}
