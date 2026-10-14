import type { DatedLabourRate } from './dated-labour-commercial-resolver.js';
import {
  add,
  date,
  decimal,
  identity,
  MAX,
  multiply,
  quantity,
  type Rational,
  rate,
  rounded,
} from './labour-math.js';
import type { CommercialSnapshot } from './service-evidence-service.js';

/** Immutable host provenance. Digest equality detects conflicting supplied revisions, not authenticity. */
export interface LabourPolicyProvenance {
  id: string;
  version: string;
  digest: string;
}

/** Private approved compensation evidence, already authorized and selected by the host. */
export interface ApprovedLabourValuationEvidence {
  tenantId: string;
  participantProfileId: string;
  entryId: string;
  snapshotId: string;
  groupId: string;
  groupVersion: string;
  policy: LabourPolicyProvenance;
  snapshot: CommercialSnapshot & {
    id: string;
    tenantId: string;
    timeEntryId: string;
  };
}

/** Explicit analytical scope; membership is supplied evidence, never a database or authorization query. */
export interface LabourValuationReconciliationInput {
  tenantId: string;
  currency: string;
  groupId: string;
  groupVersion: string;
  mode: 'half-up-exact-loaded-aggregate';
  evidence: readonly ApprovedLabourValuationEvidence[];
}

/** Private analytical result. No returned amount is a posting instruction. */
export interface LabourValuationReconciliation {
  tenantId: string;
  currency: string;
  groupId: string;
  groupVersion: string;
  mode: 'half-up-exact-loaded-aggregate';
  version: 'labour-valuation-reconciliation-v1';
  canonicalCostMinor: number;
  analyticalCostMinor: number;
  /** Analytical minus canonical; may be negative although evidence cannot be. */
  differenceMinor: number;
  evidence: Array<{
    entryId: string;
    snapshotId: string;
    participantProfileId: string;
    policy: LabourPolicyProvenance;
    calculationVersion: string;
  }>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Missing labour snapshot terms.');
  return value as Record<string, unknown>;
}
function minor(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Expected nonnegative safe integer labour amount.');
  return value as number;
}
function exactEvidence(
  snapshot: CommercialSnapshot,
  currency: string,
): { exact: Rational; canonical: number } {
  if (!snapshot || snapshot.currency !== currency)
    throw new Error('Labour evidence currency mismatch.');
  if (
    !['dated-labour-v1', 'dated-percentage-labour-v1'].includes(
      snapshot.version,
    )
  )
    throw new Error('Unsupported labour calculation version.');
  const terms = object(snapshot.terms);
  if (
    terms.currency !== currency ||
    terms.rounding !== 'half-up-per-component' ||
    typeof terms.billable !== 'boolean'
  )
    throw new Error('Unsupported or inconsistent labour terms.');
  date(terms.workDate as string);
  date(terms.effectiveFrom as string);
  if ((terms.workDate as string) < (terms.effectiveFrom as string))
    throw new Error('Labour date outside selected period.');
  if (terms.effectiveUntil !== undefined) {
    date(terms.effectiveUntil as string);
    if ((terms.workDate as string) >= (terms.effectiveUntil as string))
      throw new Error('Labour date outside selected period.');
  }
  const q = quantity(terms.quantity);
  const wageTerms = object(terms.wage);
  const wageRate = rate(wageTerms as unknown as DatedLabourRate);
  const wageHourly = decimal(wageRate.rateMinor, 'Hourly wage');
  const wageExact = multiply(q, wageHourly);
  const wage = rounded(wageExact);
  let burdenHourly: Rational;
  let suppliedBurden: unknown;
  if (snapshot.version === 'dated-labour-v1') {
    if ('burdenPercent' in terms || 'burdenBasis' in terms)
      throw new Error('Ambiguous labour burden.');
    const burdenTerms = object(terms.burden);
    burdenHourly = decimal(
      rate(burdenTerms as unknown as DatedLabourRate).rateMinor,
      'Hourly burden',
    );
    suppliedBurden = burdenTerms.amount;
  } else {
    if ('burden' in terms) throw new Error('Ambiguous labour burden.');
    const percentTerms = object(terms.burdenPercent);
    identity(percentTerms.id as string, 'Percentage id');
    identity(percentTerms.version as string, 'Percentage version');
    const percent = decimal(percentTerms.percent as string, 'Burden percent');
    burdenHourly = multiply(wageHourly, {
      numerator: percent.numerator,
      denominator: percent.denominator * 100n,
    });
    const basis = object(terms.burdenBasis);
    if (
      basis.wageId !== wageRate.id ||
      basis.wageVersion !== wageRate.version ||
      basis.hourlyNumerator !== burdenHourly.numerator.toString() ||
      basis.hourlyDenominator !== burdenHourly.denominator.toString()
    )
      throw new Error('Percentage burden basis differs from retained terms.');
    suppliedBurden = percentTerms.amount;
  }
  const burdenExact = multiply(q, burdenHourly);
  const burden = rounded(burdenExact);
  const canonical = BigInt(wage) + BigInt(burden);
  if (canonical > MAX)
    throw new Error('Loaded labour cost exceeds safe integer minor units.');
  if (
    minor(snapshot.amount) !== wage ||
    minor(wageTerms.amount) !== wage ||
    minor(suppliedBurden) !== burden ||
    minor(terms.loadedCostMinor) !== Number(canonical)
  )
    throw new Error(
      'Canonical labour snapshot does not reconcile with retained terms.',
    );
  return { exact: add(wageExact, burdenExact), canonical: Number(canonical) };
}

/**
 * Reconcile immutable private evidence; never reprice or mutate posted facts.
 * The host must authorize every entry and exclude superseded/corrected evidence.
 * IDs/digests validate consistency of supplied data, not authenticity or access.
 * Reversals and mixed-sign evidence are unsupported; apply their own versioned contract.
 */
export function reconcileLabourValuation(
  input: LabourValuationReconciliationInput,
): LabourValuationReconciliation {
  identity(input.tenantId, 'Tenant id');
  identity(input.groupId, 'Group id');
  identity(input.groupVersion, 'Group version');
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency))
    throw new Error('Explicit currency is required.');
  if (input.mode !== 'half-up-exact-loaded-aggregate')
    throw new Error('Unsupported analytical labour mode.');
  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length === 0 ||
    input.evidence.length > 10000
  )
    throw new Error('Supply between 1 and 10000 labour evidence records.');
  const entries = new Set<string>();
  const snapshots = new Set<string>();
  const policies = new Map<string, string>();
  const rates = new Map<string, string>();
  let exact: Rational = { numerator: 0n, denominator: 1n };
  let canonical = 0n;
  const evidence: LabourValuationReconciliation['evidence'] = [];
  for (const item of input.evidence) {
    if (
      !item ||
      item.tenantId !== input.tenantId ||
      item.groupId !== input.groupId ||
      item.groupVersion !== input.groupVersion
    )
      throw new Error('Labour evidence tenant/group mismatch.');
    identity(item.entryId, 'Entry id');
    identity(item.snapshotId, 'Snapshot id');
    identity(item.participantProfileId, 'Worker id');
    if (
      !item.snapshot ||
      item.snapshot.id !== item.snapshotId ||
      item.snapshot.timeEntryId !== item.entryId ||
      item.snapshot.tenantId !== input.tenantId
    )
      throw new Error('Labour snapshot identity mismatch.');
    if (entries.has(item.entryId) || snapshots.has(item.snapshotId))
      throw new Error('Duplicate labour evidence.');
    entries.add(item.entryId);
    snapshots.add(item.snapshotId);
    const policy = object(item.policy);
    identity(policy.id as string, 'Policy id');
    identity(policy.version as string, 'Policy version');
    identity(policy.digest as string, 'Policy digest');
    const policyKey = JSON.stringify([policy.id, policy.version]);
    if (policies.has(policyKey) && policies.get(policyKey) !== policy.digest)
      throw new Error('Conflicting labour policy revision.');
    policies.set(policyKey, policy.digest as string);
    const value = exactEvidence(item.snapshot, input.currency);
    for (const kind of ['wage', 'burden', 'burdenPercent']) {
      const terms = item.snapshot.terms[kind];
      if (terms === undefined) continue;
      const selected = object(terms);
      const key = JSON.stringify([
        item.participantProfileId,
        kind,
        selected.id,
        selected.version,
      ]);
      const rateValue = String(
        kind === 'burdenPercent' ? selected.percent : selected.rateMinor,
      );
      if (rates.has(key) && rates.get(key) !== rateValue)
        throw new Error('Conflicting retained labour rate revision.');
      rates.set(key, rateValue);
    }
    canonical += BigInt(value.canonical);
    if (canonical > MAX)
      throw new Error(
        'Canonical labour aggregate exceeds safe integer minor units.',
      );
    exact = add(exact, value.exact);
    evidence.push({
      entryId: item.entryId,
      snapshotId: item.snapshotId,
      participantProfileId: item.participantProfileId,
      policy: {
        id: policy.id as string,
        version: policy.version as string,
        digest: policy.digest as string,
      },
      calculationVersion: item.snapshot.version,
    });
  }
  // Stable ordinal ordering, independent of process locale and input permutation.
  evidence.sort((a, b) =>
    a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0,
  );
  const analytical = rounded(exact);
  return {
    tenantId: input.tenantId,
    currency: input.currency,
    groupId: input.groupId,
    groupVersion: input.groupVersion,
    mode: input.mode,
    version: 'labour-valuation-reconciliation-v1',
    canonicalCostMinor: Number(canonical),
    analyticalCostMinor: analytical,
    differenceMinor: analytical - Number(canonical),
    evidence,
  };
}
