/** Deterministic calculation for version-two commission waterfalls. */

import { isDeepStrictEqual } from 'node:util';
import {
  type MetricProvider,
  WATERFALL_POOL_RESIDUAL_RULES,
  WATERFALL_POOL_ZERO_WEIGHT_RULES,
  type WaterfallCalculationResult,
  type WaterfallEvent,
  type WaterfallFrozenInputs,
  type WaterfallMetricPeriod,
  type WaterfallPlan,
  type WaterfallPoolMembershipResolver,
  type WaterfallPoolMemberTrace,
  type WaterfallPoolSnapshot,
  type WaterfallPoolSpec,
  type WaterfallPoolStepTrace,
  type WaterfallRecipientDescriptor,
  type WaterfallResolvedRecipient,
  type WaterfallStep,
  type WaterfallStepConditions,
  type WaterfallStepTrace,
} from '../types.js';

export type WaterfallRecipientResolver = (
  descriptor: WaterfallRecipientDescriptor,
  event: WaterfallEvent,
) => WaterfallResolvedRecipient | null;

/** Host-owned resolver registry; a recipient namespace is never guessed. */
export class WaterfallRecipientResolverRegistry {
  private readonly resolvers = new Map<string, WaterfallRecipientResolver>();

  register(kind: string, resolver: WaterfallRecipientResolver): void {
    if (!kind) throw new Error('Waterfall recipient resolver kind is required');
    if (this.resolvers.has(kind)) {
      throw new Error(
        `Waterfall recipient resolver '${kind}' is already registered`,
      );
    }
    this.resolvers.set(kind, resolver);
  }

  resolve(
    descriptor: WaterfallRecipientDescriptor,
    event: WaterfallEvent,
  ): WaterfallResolvedRecipient | null {
    return this.resolvers.get(descriptor.kind)?.(descriptor, event) ?? null;
  }
}

export interface CalculateWaterfallOptions {
  resolver?: WaterfallRecipientResolverRegistry;
  /** Replays pass the frozen inputs returned by the first calculation. */
  frozenInputs?: WaterfallFrozenInputs;
  /**
   * Prepared pool inputs by step key, from {@link prepareWaterfallPools}.
   * `null` marks a pool whose descriptor did not resolve (the step flows to
   * the remainder sink). Required for every participating pool step unless
   * `frozenInputs` already carries it.
   */
  pools?: Record<string, WaterfallPoolSnapshot | null>;
}

/** Host-injected providers used to prepare pool inputs. */
export interface PrepareWaterfallPoolsOptions {
  resolver?: WaterfallRecipientResolverRegistry;
  /** Lists the members of a resolved pool. Required when a pool step participates. */
  poolMembers?: WaterfallPoolMembershipResolver;
  /** Supplies member weights for pool steps that name a `metric`. */
  metricProvider?: MetricProvider;
  /** Measurement window passed to the metric provider and frozen in the trace. */
  metricPeriod?: { start: Date | string; end: Date | string };
}

/**
 * Resolve every participating pool step's identity, members, and metric
 * weights at the authoritative calculation event. Pass the result to
 * {@link calculateWaterfall} as `pools`; the trace freezes it so replay
 * never calls the providers again.
 */
export async function prepareWaterfallPools(
  plan: WaterfallPlan,
  event: WaterfallEvent,
  options: PrepareWaterfallPoolsOptions = {},
): Promise<Record<string, WaterfallPoolSnapshot | null>> {
  validateWaterfallPlan(plan);
  const period = normalizePeriod(options.metricPeriod);
  const facts = event.facts ?? {};
  const pools: Record<string, WaterfallPoolSnapshot | null> =
    Object.create(null);
  for (const step of plan.steps) {
    if (!step.pool || !conditionsMatch(step.conditions, facts)) continue;
    const resolved = options.resolver?.resolve(step.recipient, event) ?? null;
    if (!resolved) {
      pools[step.key] = null;
      continue;
    }
    const pool = freezeRecipient(resolved);
    if (!options.poolMembers)
      throw new Error(
        `Waterfall pool step '${step.key}' requires a poolMembers resolver`,
      );
    const members = sortMembers(
      (await options.poolMembers(pool, event)).map((member) =>
        freezeRecipient(assertRecipient(member, `pool '${step.key}' member`)),
      ),
      step.key,
    );
    const metric = step.pool.metric ?? null;
    let weights = members.map(() => 1);
    if (metric !== null) {
      if (!options.metricProvider)
        throw new Error(
          `Waterfall pool step '${step.key}' requires a metricProvider for metric '${metric}'`,
        );
      const values = await options.metricProvider.getMetricValues({
        metric,
        pool,
        members,
        period,
        event,
      });
      weights = weightsFromMetricValues(step.key, members, values);
    }
    pools[step.key] = {
      pool,
      metric,
      period: metric === null ? null : period,
      members: members.map((recipient, index) => ({
        recipient,
        weight: weights[index],
      })),
    };
  }
  return pools;
}

/**
 * {@link prepareWaterfallPools} followed by {@link calculateWaterfall}.
 * With `frozenInputs` it replays without calling any provider.
 */
export async function calculateWaterfallWithPools(
  plan: WaterfallPlan,
  event: WaterfallEvent,
  options: CalculateWaterfallOptions & PrepareWaterfallPoolsOptions = {},
): Promise<WaterfallCalculationResult> {
  if (options.frozenInputs || options.pools)
    return calculateWaterfall(plan, event, options);
  const pools = await prepareWaterfallPools(plan, event, options);
  return calculateWaterfall(plan, event, { ...options, pools });
}

/**
 * Allocate integer minor units in step order. The pure service never creates
 * payouts; hosts persist the returned trace as their authoritative evidence.
 */
export function calculateWaterfall(
  plan: WaterfallPlan,
  event: WaterfallEvent,
  options: CalculateWaterfallOptions = {},
): WaterfallCalculationResult {
  validateWaterfallPlan(plan);
  const planFingerprint = fingerprintPlan(plan);
  const calculationEvent: WaterfallEvent = options.frozenInputs
    ? {
        grossAmountCents: options.frozenInputs.grossAmountCents,
        currency: options.frozenInputs.currency,
        facts: options.frozenInputs.facts,
        customBases: options.frozenInputs.customBases,
        applicationFeeSettledCents:
          options.frozenInputs.applicationFeeSettledCents,
      }
    : event;
  validateEvent(plan, calculationEvent);
  if (
    options.frozenInputs &&
    (options.frozenInputs.planKey !== plan.planKey ||
      options.frozenInputs.planVersion !== plan.version ||
      options.frozenInputs.planFingerprint !== planFingerprint)
  )
    throw new Error(
      'Waterfall frozen inputs belong to a different plan version',
    );
  const facts = options.frozenInputs?.facts ?? event.facts ?? {};
  const frozenInputs: WaterfallFrozenInputs = {
    planKey: options.frozenInputs?.planKey ?? plan.planKey,
    planVersion: options.frozenInputs?.planVersion ?? plan.version,
    planFingerprint: options.frozenInputs?.planFingerprint ?? planFingerprint,
    currency: options.frozenInputs?.currency ?? event.currency,
    grossAmountCents:
      options.frozenInputs?.grossAmountCents ?? event.grossAmountCents,
    facts: { ...facts },
    customBases: {
      ...(options.frozenInputs?.customBases ?? event.customBases),
    },
    recipientByStep: Object.assign(
      Object.create(null),
      Object.fromEntries(
        Object.entries(options.frozenInputs?.recipientByStep ?? {}).map(
          ([key, recipient]) => [
            key,
            recipient ? freezeRecipient(recipient) : null,
          ],
        ),
      ),
    ),
    remainderSink: options.frozenInputs
      ? freezeRecipient(options.frozenInputs.remainderSink)
      : resolveSink(plan, calculationEvent, options),
    applicationFeeSettledCents:
      options.frozenInputs?.applicationFeeSettledCents ??
      event.applicationFeeSettledCents ??
      0,
  };
  if (plan.steps.some((step) => step.pool)) {
    const poolsByStep: Record<string, WaterfallPoolSnapshot> =
      Object.create(null);
    for (const [key, snapshot] of Object.entries(
      options.frozenInputs?.poolsByStep ?? {},
    ))
      poolsByStep[key] = normalizePoolSnapshot(snapshot, key);
    frozenInputs.poolsByStep = poolsByStep;
  }
  assertWholeNonNegative(
    frozenInputs.applicationFeeSettledCents,
    'applicationFeeSettledCents',
  );

  let remainingCents = calculationEvent.grossAmountCents;
  let redirectedToSinkCents = 0;
  let totalRecipientAllocatedCents = 0;
  let remainingFeeOffsetCents = frozenInputs.applicationFeeSettledCents;
  const steps: WaterfallStepTrace[] = [];

  for (const step of plan.steps) {
    if (!conditionsMatch(step.conditions, facts)) {
      steps.push({
        key: step.key,
        baseCents: 0,
        amountCents: 0,
        recipient: null,
        redirectedToSinkCents: 0,
        applicationFeeOffsetCents: 0,
        payableCents: 0,
        skipped: 'condition_not_met',
      });
      continue;
    }
    const baseCents = resolveBase(step, calculationEvent, remainingCents);
    const amountCents = resolveAmount(step, baseCents);
    if (amountCents > remainingCents) {
      throw new Error(
        `Waterfall step '${step.key}' allocates ${amountCents} cents but only ${remainingCents} cents remain`,
      );
    }
    if (step.pool) {
      const { recipient, snapshot } = resolvePoolStep(
        step,
        options,
        frozenInputs,
      );
      remainingCents -= amountCents;
      if (!recipient || !snapshot) {
        redirectedToSinkCents += amountCents;
        steps.push({
          key: step.key,
          baseCents,
          amountCents,
          recipient: null,
          redirectedToSinkCents: amountCents,
          applicationFeeOffsetCents: 0,
          payableCents: 0,
        });
        continue;
      }
      const pool = allocatePool(amountCents, step.pool, snapshot);
      const memberCents = amountCents - pool.toSinkCents;
      totalRecipientAllocatedCents += memberCents;
      redirectedToSinkCents += pool.toSinkCents;
      steps.push({
        key: step.key,
        baseCents,
        amountCents,
        recipient,
        redirectedToSinkCents: pool.toSinkCents,
        applicationFeeOffsetCents: 0,
        payableCents: memberCents,
        pool: pool.trace,
      });
      continue;
    }
    const recipient = resolveStepRecipient(
      step,
      calculationEvent,
      options,
      frozenInputs,
    );
    let applicationFeeOffsetCents = 0;
    if (
      recipient &&
      descriptorMatches(plan.applicationFeeOffsetRecipient, step.recipient)
    ) {
      applicationFeeOffsetCents = Math.min(
        remainingFeeOffsetCents,
        amountCents,
      );
      remainingFeeOffsetCents -= applicationFeeOffsetCents;
    }
    remainingCents -= amountCents;
    if (recipient) totalRecipientAllocatedCents += amountCents;
    else redirectedToSinkCents += amountCents;
    steps.push({
      key: step.key,
      baseCents,
      amountCents,
      recipient,
      redirectedToSinkCents: recipient ? 0 : amountCents,
      applicationFeeOffsetCents,
      payableCents: recipient ? amountCents - applicationFeeOffsetCents : 0,
    });
  }
  if (remainingFeeOffsetCents !== 0) {
    throw new Error(
      'Waterfall application fee offset has no resolved configured recipient allocation',
    );
  }
  const totalSinkCents = remainingCents + redirectedToSinkCents;
  const closure =
    totalRecipientAllocatedCents +
    totalSinkCents -
    calculationEvent.grossAmountCents;
  if (closure !== 0)
    throw new Error(`Waterfall closure failed by ${closure} cents`);
  return {
    trace: {
      planKey: plan.planKey,
      planVersion: plan.version,
      currency: plan.currency,
      grossAmountCents: calculationEvent.grossAmountCents,
      steps,
      remainderSink: frozenInputs.remainderSink,
      remainderSinkCents: totalSinkCents,
      totalRecipientAllocatedCents,
      totalSinkCents,
      closureCents: 0,
      roundingMode: 'half_away_from_zero',
      frozenInputs,
    },
  };
}

function resolveSink(
  plan: WaterfallPlan,
  event: WaterfallEvent,
  options: CalculateWaterfallOptions,
): WaterfallResolvedRecipient {
  const sink = options.resolver?.resolve(plan.remainderSink, event) ?? null;
  if (!sink)
    throw new Error('Waterfall remainderSink must resolve to a recipient');
  return freezeRecipient(sink);
}

function resolveStepRecipient(
  step: WaterfallStep,
  event: WaterfallEvent,
  options: CalculateWaterfallOptions,
  frozen: WaterfallFrozenInputs,
): WaterfallResolvedRecipient | null {
  if (Object.hasOwn(frozen.recipientByStep, step.key)) {
    const existing = frozen.recipientByStep[step.key];
    return existing ? freezeRecipient(existing) : null;
  }
  const recipient = options.resolver?.resolve(step.recipient, event) ?? null;
  const frozenRecipient = recipient ? freezeRecipient(recipient) : null;
  Object.defineProperty(frozen.recipientByStep, step.key, {
    value: frozenRecipient,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return frozenRecipient;
}

function resolvePoolStep(
  step: WaterfallStep,
  options: CalculateWaterfallOptions,
  frozen: WaterfallFrozenInputs,
): {
  recipient: WaterfallResolvedRecipient | null;
  snapshot: WaterfallPoolSnapshot | null;
} {
  const poolsByStep = frozen.poolsByStep as Record<
    string,
    WaterfallPoolSnapshot
  >;
  if (Object.hasOwn(frozen.recipientByStep, step.key)) {
    const recipient = frozen.recipientByStep[step.key];
    if (!recipient) return { recipient: null, snapshot: null };
    const snapshot = Object.hasOwn(poolsByStep, step.key)
      ? poolsByStep[step.key]
      : undefined;
    if (!snapshot)
      throw new Error(
        `Waterfall frozen inputs lack the pool snapshot for step '${step.key}'`,
      );
    if (!isDeepStrictEqual(snapshot.pool, recipient))
      throw new Error(
        `Waterfall frozen pool snapshot for step '${step.key}' does not match its frozen recipient`,
      );
    return { recipient: freezeRecipient(recipient), snapshot };
  }
  if (!options.pools || !Object.hasOwn(options.pools, step.key))
    throw new Error(
      `Waterfall pool step '${step.key}' requires prepared pool inputs; use prepareWaterfallPools() or calculateWaterfallWithPools()`,
    );
  const prepared = options.pools[step.key];
  const snapshot = prepared ? normalizePoolSnapshot(prepared, step.key) : null;
  const recipient = snapshot ? freezeRecipient(snapshot.pool) : null;
  Object.defineProperty(frozen.recipientByStep, step.key, {
    value: recipient,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  if (snapshot) poolsByStep[step.key] = snapshot;
  return { recipient, snapshot };
}

/**
 * Split `amountCents` across pool members by weight with exact integer
 * arithmetic: each member receives `floor(amount × weight ÷ total)`; the
 * indivisible residual goes to the sink (default) or, under
 * `largest_remainder`, one unit at a time to members ordered by largest
 * fractional remainder, then larger weight, then `kind`, then `id`.
 */
function allocatePool(
  amountCents: number,
  spec: WaterfallPoolSpec,
  snapshot: WaterfallPoolSnapshot,
): { toSinkCents: number; trace: WaterfallPoolStepTrace } {
  const residualRule = spec.residual ?? 'remainder_sink';
  const members = snapshot.members;
  const totalWeight = members.reduce((sum, member) => sum + member.weight, 0);
  const base = {
    metric: snapshot.metric,
    period: snapshot.period ? { ...snapshot.period } : null,
    totalWeight,
    residualRule,
  };
  const useEqual =
    members.length > 0 &&
    totalWeight === 0 &&
    (spec.zeroWeight ?? 'remainder_sink') === 'equal';
  if (members.length === 0 || (totalWeight === 0 && !useEqual)) {
    return {
      toSinkCents: amountCents,
      trace: {
        ...base,
        distribution: 'remainder_sink',
        residualToSinkCents: 0,
        members: members.map((member) => ({
          recipient: freezeRecipient(member.recipient),
          weight: member.weight,
          shareFraction: 0,
          amountCents: 0,
        })),
      },
    };
  }
  const effective = members.map((member) =>
    BigInt(useEqual ? 1 : member.weight),
  );
  const total = effective.reduce((sum, weight) => sum + weight, 0n);
  const amount = BigInt(amountCents);
  const floors = effective.map((weight) => (amount * weight) / total);
  const remainders = effective.map((weight) => (amount * weight) % total);
  let residual = Number(
    amount - floors.reduce((sum, cents) => sum + cents, 0n),
  );
  const cents = floors.map(Number);
  let residualToSinkCents = residual;
  if (residualRule === 'largest_remainder') {
    const order = members
      .map((_, index) => index)
      .sort(
        (a, b) =>
          compareBigInt(remainders[b], remainders[a]) ||
          compareBigInt(effective[b], effective[a]) ||
          compareCodeUnits(
            members[a].recipient.kind,
            members[b].recipient.kind,
          ) ||
          compareCodeUnits(members[a].recipient.id, members[b].recipient.id),
      );
    for (const index of order) {
      if (residual === 0) break;
      cents[index] += 1;
      residual -= 1;
    }
    residualToSinkCents = 0;
  }
  const memberTraces: WaterfallPoolMemberTrace[] = members.map(
    (member, index) => ({
      recipient: freezeRecipient(member.recipient),
      weight: member.weight,
      shareFraction: Number(effective[index]) / Number(total),
      amountCents: cents[index],
    }),
  );
  return {
    toSinkCents: residualToSinkCents,
    trace: {
      ...base,
      distribution: useEqual || snapshot.metric === null ? 'equal' : 'weighted',
      residualToSinkCents,
      members: memberTraces,
    },
  };
}

function compareBigInt(a: bigint, b: bigint): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareCodeUnits(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function assertRecipient(
  value: unknown,
  label: string,
): WaterfallResolvedRecipient {
  const recipient = value as WaterfallResolvedRecipient | null;
  if (
    !recipient ||
    typeof recipient !== 'object' ||
    typeof recipient.kind !== 'string' ||
    !recipient.kind ||
    typeof recipient.id !== 'string' ||
    !recipient.id
  )
    throw new Error(`Waterfall ${label} must have non-empty kind and id`);
  return recipient;
}

/** Canonical `(kind, id)` order; duplicate member identities are rejected. */
function sortMembers<T extends WaterfallResolvedRecipient>(
  members: T[],
  stepKey: string,
): T[] {
  const sorted = [...members].sort(
    (a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.id, b.id),
  );
  for (let index = 1; index < sorted.length; index++) {
    if (
      sorted[index].kind === sorted[index - 1].kind &&
      sorted[index].id === sorted[index - 1].id
    )
      throw new Error(
        `Waterfall pool step '${stepKey}' lists member ${sorted[index].kind}:${sorted[index].id} more than once`,
      );
  }
  return sorted;
}

function weightsFromMetricValues(
  stepKey: string,
  members: readonly WaterfallResolvedRecipient[],
  values: readonly { kind: string; id: string; value: number }[],
): number[] {
  if (!Array.isArray(values))
    throw new Error(
      `Waterfall pool step '${stepKey}' metric provider must return an array`,
    );
  const indexByMember = new Map<string, number>();
  for (const [index, member] of members.entries())
    indexByMember.set(JSON.stringify([member.kind, member.id]), index);
  const weights = members.map(() => 0);
  const seen = new Set<number>();
  for (const entry of values) {
    const index = indexByMember.get(JSON.stringify([entry?.kind, entry?.id]));
    if (index === undefined)
      throw new Error(
        `Waterfall pool step '${stepKey}' metric value names a non-member`,
      );
    if (seen.has(index))
      throw new Error(
        `Waterfall pool step '${stepKey}' metric value repeats a member`,
      );
    seen.add(index);
    assertWeight(entry.value, stepKey);
    weights[index] = entry.value;
  }
  return weights;
}

function assertWeight(value: unknown, stepKey: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(
      `Waterfall pool step '${stepKey}' weights must be non-negative safe integers`,
    );
}

/** Validate and copy a host-supplied or frozen pool snapshot. */
function normalizePoolSnapshot(
  snapshot: WaterfallPoolSnapshot,
  stepKey: string,
): WaterfallPoolSnapshot {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !Array.isArray(snapshot.members)
  )
    throw new Error(
      `Waterfall pool snapshot for step '${stepKey}' must list members`,
    );
  if (
    snapshot.metric !== null &&
    (typeof snapshot.metric !== 'string' || !snapshot.metric)
  )
    throw new Error(
      `Waterfall pool snapshot for step '${stepKey}' has an invalid metric`,
    );
  const members = sortMembers(
    snapshot.members.map((member) => {
      assertWeight(member?.weight, stepKey);
      return {
        ...freezeRecipient(
          assertRecipient(member.recipient, `pool '${stepKey}' member`),
        ),
        weight: member.weight,
      };
    }),
    stepKey,
  );
  if (snapshot.metric === null && members.some((member) => member.weight !== 1))
    throw new Error(
      `Waterfall pool snapshot for step '${stepKey}' uses equal weights, so every weight must be 1`,
    );
  let total = 0;
  for (const member of members) {
    total += member.weight;
    if (!Number.isSafeInteger(total))
      throw new Error(
        `Waterfall pool step '${stepKey}' total weight exceeds the safe integer range`,
      );
  }
  return {
    pool: freezeRecipient(assertRecipient(snapshot.pool, `pool '${stepKey}'`)),
    metric: snapshot.metric,
    period: snapshot.period ? normalizePeriod(snapshot.period) : null,
    members: members.map(({ weight, ...recipient }) => ({
      recipient,
      weight,
    })),
  };
}

function normalizePeriod(
  period: { start: Date | string; end: Date | string } | undefined | null,
): WaterfallMetricPeriod | null {
  if (!period) return null;
  const start = new Date(period.start);
  const end = new Date(period.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    throw new Error('Waterfall metric period must use valid dates');
  if (end <= start)
    throw new Error('Waterfall metric period end must be later than start');
  return { start: start.toISOString(), end: end.toISOString() };
}

function freezeRecipient(
  recipient: WaterfallResolvedRecipient,
): WaterfallResolvedRecipient {
  return {
    kind: recipient.kind,
    id: recipient.id,
    ...(recipient.metadata
      ? { metadata: structuredClone(recipient.metadata) }
      : {}),
  };
}

function resolveBase(
  step: WaterfallStep,
  event: WaterfallEvent,
  remainderCents: number,
): number {
  if (step.base === 'gross') return event.grossAmountCents;
  if (step.base === 'previous_remainder') return remainderCents;
  const value = event.customBases?.[step.customBaseKey ?? ''];
  if (value === undefined)
    throw new Error(
      `Waterfall step '${step.key}' requires custom base '${step.customBaseKey ?? ''}'`,
    );
  assertWholeNonNegative(value, `custom base '${step.customBaseKey}'`);
  return value;
}

function resolveAmount(step: WaterfallStep, baseCents: number): number {
  const raw =
    step.amount.kind === 'percent'
      ? roundPercentCents(baseCents, step.amount.rate)
      : step.amount.amountCents;
  return Math.min(
    step.capCents ?? Number.MAX_SAFE_INTEGER,
    Math.max(step.floorCents ?? 0, raw),
  );
}

function roundPercentCents(baseCents: number, rate: number): number {
  const [numerator, denominator] = decimalFraction(rate);
  const rounded =
    (BigInt(baseCents) * numerator + denominator / 2n) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Waterfall percent allocation exceeds safe integer cents');
  return Number(rounded);
}

function decimalFraction(value: number): [bigint, bigint] {
  const [coefficient, exponentText] = value.toString().toLowerCase().split('e');
  const exponent = exponentText ? Number(exponentText) : 0;
  const [whole, fractional = ''] = coefficient.split('.');
  const digits = `${whole}${fractional}`;
  const scale = fractional.length - exponent;
  if (scale <= 0) return [BigInt(digits) * 10n ** BigInt(-scale), 1n];
  return [BigInt(digits), 10n ** BigInt(scale)];
}

function fingerprintPlan(plan: WaterfallPlan): string {
  return JSON.stringify({
    tenantId: plan.tenantId ?? null,
    planKey: plan.planKey,
    version: plan.version,
    currency: plan.currency,
    steps: plan.steps,
    remainderSink: plan.remainderSink,
    applicationFeeOffsetRecipient: plan.applicationFeeOffsetRecipient ?? null,
  });
}

function conditionsMatch(
  conditions: WaterfallStepConditions | undefined,
  facts: Record<string, string | undefined>,
): boolean {
  if (!conditions) return true;
  return (['product', 'zone', 'source', 'member'] as const).every(
    (key) =>
      conditions[key] === undefined ||
      conditions[key].includes(facts[key] ?? ''),
  );
}

function descriptorMatches(
  a: WaterfallRecipientDescriptor | undefined,
  b: WaterfallRecipientDescriptor,
): boolean {
  // Metadata is host-defined routing identity, not merely display evidence.
  // Object key order is immaterial, including inside nested metadata.
  return a !== undefined && isDeepStrictEqual(a, b);
}

/** Validate persisted v2 terms before a plan becomes active. */
export function validateWaterfallPlan(plan: WaterfallPlan): void {
  if (!plan.planKey || !Number.isInteger(plan.version) || plan.version < 1)
    throw new Error(
      'Waterfall plan requires a planKey and positive integer version',
    );
  const keys = new Set<string>();
  for (const step of plan.steps) {
    if (typeof step.key !== 'string' || !step.key || keys.has(step.key))
      throw new Error(
        `Waterfall step keys must be non-empty strings and unique: '${step.key}'`,
      );
    keys.add(step.key);
    if (['__proto__', 'constructor', 'prototype'].includes(step.key))
      throw new Error(`Waterfall step '${step.key}' uses a reserved key`);
    if (!step.recipient?.kind)
      throw new Error(
        `Waterfall step '${step.key}' requires a recipient descriptor`,
      );
    if (step.pool !== undefined) validatePoolSpec(plan, step);
    if (step.base === 'custom' && !step.customBaseKey)
      throw new Error(
        `Waterfall step '${step.key}' requires customBaseKey for custom base`,
      );
    if (!['gross', 'previous_remainder', 'custom'].includes(step.base))
      throw new Error(`Waterfall step '${step.key}' has an invalid base`);
    if (!['percent', 'fixed'].includes(step.amount.kind))
      throw new Error(
        `Waterfall step '${step.key}' has an invalid amount kind`,
      );
    if (step.conditions !== undefined) {
      if (
        !step.conditions ||
        typeof step.conditions !== 'object' ||
        Array.isArray(step.conditions)
      )
        throw new Error(
          `Waterfall step '${step.key}' conditions must be an object`,
        );
      for (const [key, values] of Object.entries(step.conditions)) {
        if (!['product', 'zone', 'source', 'member'].includes(key))
          throw new Error(
            `Waterfall step '${step.key}' has an unknown condition '${key}'`,
          );
        if (
          !Array.isArray(values) ||
          values.some((value) => typeof value !== 'string' || !value)
        )
          throw new Error(
            `Waterfall step '${step.key}' condition '${key}' must be an array of non-empty strings`,
          );
      }
    }
    if (
      step.amount.kind === 'percent' &&
      (!Number.isFinite(step.amount.rate) ||
        step.amount.rate < 0 ||
        step.amount.rate > 1)
    )
      throw new Error(
        `Waterfall step '${step.key}' percent rate must be in [0, 1]`,
      );
    if (step.amount.kind === 'fixed')
      assertWholeNonNegative(
        step.amount.amountCents,
        `Waterfall step '${step.key}' fixed amount`,
      );
    if (step.floorCents !== undefined)
      assertWholeNonNegative(
        step.floorCents,
        `Waterfall step '${step.key}' floor`,
      );
    if (step.capCents !== undefined)
      assertWholeNonNegative(step.capCents, `Waterfall step '${step.key}' cap`);
    if (
      step.floorCents !== undefined &&
      step.capCents !== undefined &&
      step.floorCents > step.capCents
    )
      throw new Error(`Waterfall step '${step.key}' floor cannot exceed cap`);
  }
  if (!plan.remainderSink?.kind)
    throw new Error('Waterfall plan requires a remainderSink descriptor');
  if (
    plan.applicationFeeOffsetRecipient &&
    !plan.applicationFeeOffsetRecipient.kind
  )
    throw new Error(
      'Waterfall application fee offset requires a recipient descriptor',
    );
}

function validatePoolSpec(plan: WaterfallPlan, step: WaterfallStep): void {
  const pool = step.pool as unknown;
  if (
    !pool ||
    typeof pool !== 'object' ||
    Array.isArray(pool) ||
    Object.getPrototypeOf(pool) !== Object.prototype
  )
    throw new Error(`Waterfall step '${step.key}' pool must be an object`);
  const spec = pool as Record<string, unknown>;
  for (const key of Object.keys(spec))
    if (!['metric', 'residual', 'zeroWeight'].includes(key))
      throw new Error(
        `Waterfall step '${step.key}' pool has an unknown option '${key}'`,
      );
  if (
    spec.metric !== undefined &&
    (typeof spec.metric !== 'string' || !spec.metric)
  )
    throw new Error(
      `Waterfall step '${step.key}' pool metric must be a non-empty string`,
    );
  if (
    spec.residual !== undefined &&
    !(WATERFALL_POOL_RESIDUAL_RULES as readonly unknown[]).includes(
      spec.residual,
    )
  )
    throw new Error(`Waterfall step '${step.key}' pool residual is invalid`);
  if (
    spec.zeroWeight !== undefined &&
    !(WATERFALL_POOL_ZERO_WEIGHT_RULES as readonly unknown[]).includes(
      spec.zeroWeight,
    )
  )
    throw new Error(`Waterfall step '${step.key}' pool zeroWeight is invalid`);
  if (descriptorMatches(plan.applicationFeeOffsetRecipient, step.recipient))
    throw new Error(
      `Waterfall pool step '${step.key}' cannot be the application fee offset recipient`,
    );
}

function validateEvent(plan: WaterfallPlan, event: WaterfallEvent): void {
  if (plan.currency !== event.currency)
    throw new Error(
      'Waterfall plan and event currency must match; no FX is performed',
    );
  assertWholeNonNegative(event.grossAmountCents, 'grossAmountCents');
}

function assertWholeNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer cents value`);
}
