/** Deterministic calculation for version-two commission waterfalls. */

import type {
  WaterfallCalculationResult,
  WaterfallEvent,
  WaterfallFrozenInputs,
  WaterfallPlan,
  WaterfallRecipientDescriptor,
  WaterfallResolvedRecipient,
  WaterfallStep,
  WaterfallStepConditions,
  WaterfallStepTrace,
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
      options.frozenInputs.planVersion !== plan.version)
  )
    throw new Error(
      'Waterfall frozen inputs belong to a different plan version',
    );
  const facts = options.frozenInputs?.facts ?? event.facts ?? {};
  const frozenInputs: WaterfallFrozenInputs = {
    planKey: options.frozenInputs?.planKey ?? plan.planKey,
    planVersion: options.frozenInputs?.planVersion ?? plan.version,
    currency: options.frozenInputs?.currency ?? event.currency,
    grossAmountCents:
      options.frozenInputs?.grossAmountCents ?? event.grossAmountCents,
    facts: { ...facts },
    customBases: {
      ...(options.frozenInputs?.customBases ?? event.customBases),
    },
    recipientByStep: { ...(options.frozenInputs?.recipientByStep ?? {}) },
    remainderSink:
      options.frozenInputs?.remainderSink ??
      resolveSink(plan, calculationEvent, options),
    applicationFeeSettledCents:
      options.frozenInputs?.applicationFeeSettledCents ??
      event.applicationFeeSettledCents ??
      0,
  };
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
  return sink;
}

function resolveStepRecipient(
  step: WaterfallStep,
  event: WaterfallEvent,
  options: CalculateWaterfallOptions,
  frozen: WaterfallFrozenInputs,
): WaterfallResolvedRecipient | null {
  if (Object.hasOwn(frozen.recipientByStep, step.key))
    return frozen.recipientByStep[step.key] ?? null;
  const recipient = options.resolver?.resolve(step.recipient, event) ?? null;
  frozen.recipientByStep[step.key] = recipient;
  return recipient;
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
  return a?.kind === b.kind && a?.id === b.id;
}

/** Validate persisted v2 terms before a plan becomes active. */
export function validateWaterfallPlan(plan: WaterfallPlan): void {
  if (!plan.planKey || !Number.isInteger(plan.version) || plan.version < 1)
    throw new Error(
      'Waterfall plan requires a planKey and positive integer version',
    );
  const keys = new Set<string>();
  for (const step of plan.steps) {
    if (!step.key || keys.has(step.key))
      throw new Error(
        `Waterfall step keys must be non-empty and unique: '${step.key}'`,
      );
    keys.add(step.key);
    if (!step.recipient?.kind)
      throw new Error(
        `Waterfall step '${step.key}' requires a recipient descriptor`,
      );
    if (step.base === 'custom' && !step.customBaseKey)
      throw new Error(
        `Waterfall step '${step.key}' requires customBaseKey for custom base`,
      );
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
