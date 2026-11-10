/**
 * Plan terms and the entitlement-upgrade policy for effective-dated plan
 * versions (#4032).
 */
import type {
  PlanFeatureGrant,
  PlanTerms,
  PlanThreshold,
  ThresholdEnforcement,
} from './types.js';
import {
  isValidThreshold,
  normalizeFeatureGrants,
  parseJsonArray,
  stringifyJson,
} from './utils.js';

/** The versioned term fields, in a stable order. */
export const PLAN_TERM_FIELDS = [
  'status',
  'priceAmount',
  'currency',
  'billingInterval',
  'pricingMode',
  'minimumAmount',
  'suggestedAmount',
  'features',
  'thresholds',
] as const satisfies ReadonlyArray<keyof PlanTerms>;

/** Copy the versioned terms off a plan or version. */
export function extractPlanTerms(source: PlanTerms): PlanTerms {
  return {
    status: source.status,
    priceAmount: Number(source.priceAmount),
    currency: source.currency,
    billingInterval: source.billingInterval,
    pricingMode: source.pricingMode,
    minimumAmount: Number(source.minimumAmount),
    suggestedAmount: Number(source.suggestedAmount),
    features: canonicalFeatures(source.features),
    thresholds: canonicalThresholds(source.thresholds),
  };
}

/** True when two term sets would grant and charge the same thing. */
export function samePlanTerms(left: PlanTerms, right: PlanTerms): boolean {
  const a = extractPlanTerms(left);
  const b = extractPlanTerms(right);
  return PLAN_TERM_FIELDS.every((field) => a[field] === b[field]);
}

/** Enabled feature keys of a term set. */
export function enabledFeatureKeys(terms: Pick<PlanTerms, 'features'>) {
  return featureGrants(terms.features)
    .filter((grant) => grant.enabled !== false)
    .map((grant) => grant.featureKey);
}

/** Valid thresholds of a term set. */
export function validThresholds(
  terms: Pick<PlanTerms, 'thresholds'>,
): PlanThreshold[] {
  return parseJsonArray<PlanThreshold>(terms.thresholds).filter(
    (threshold) => Boolean(threshold) && isValidThreshold(threshold),
  );
}

const ENFORCEMENT_RANK: Record<ThresholdEnforcement, number> = {
  observe: 0,
  warn: 1,
  block: 2,
};

/**
 * The in-period upgrade policy: `to` is an upgrade of `from` when it is
 * `active` and takes nothing away. Every feature enabled in `from` stays
 * enabled, and every threshold in `to` has a counterpart in `from` (same
 * metric and window) whose limit is no higher and whose enforcement is no
 * looser. Removing a threshold loosens it; adding one restricts. Price is not
 * an entitlement and is ignored. Anything else is a downgrade, which only
 * takes effect at renewal or through an explicit authorized replacement.
 */
export function isEntitlementUpgrade(from: PlanTerms, to: PlanTerms): boolean {
  if (to.status !== 'active') return false;
  const granted = new Set(enabledFeatureKeys(to));
  if (enabledFeatureKeys(from).some((key) => !granted.has(key))) return false;
  const current = validThresholds(from);
  return validThresholds(to).every((next) => {
    const counterpart = current.find(
      (threshold) =>
        threshold.metricKey === next.metricKey &&
        threshold.window === next.window,
    );
    return (
      counterpart !== undefined &&
      next.limit >= counterpart.limit &&
      ENFORCEMENT_RANK[next.enforcement] <=
        ENFORCEMENT_RANK[counterpart.enforcement]
    );
  });
}

function featureGrants(value: string): PlanFeatureGrant[] {
  return normalizeFeatureGrants(
    parseJsonArray<string | PlanFeatureGrant>(value),
  );
}

function canonicalFeatures(value: string): string {
  return stringifyJson(featureGrants(value));
}

function canonicalThresholds(value: string): string {
  return stringifyJson(parseJsonArray<PlanThreshold>(value));
}
