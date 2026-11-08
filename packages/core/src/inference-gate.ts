/**
 * The pre-call inference gate seam (#4760, epic #4667).
 *
 * Before a call whose bound target is `source: 'hosted'` (platform-paid
 * inference), core asks the registered {@link InferenceGate} whether it may
 * run. The gate (registered by `@happyvertical/smrt-inference/gate`, which
 * reads `smrt-subscriptions` plans and `smrt-features` kill-switch rows;
 * core imports neither) answers allow, allow-with-warning, or block.
 *
 * - `byo`, `local` and `app` targets never consult the gate.
 * - No registered gate: hosted calls run (pre-#4760 behavior).
 * - A gate that throws or answers nonsense blocks the hosted call (fail
 *   closed, policy `gate-error`): a transport failure is never read as
 *   "within the cap", and since nothing ran it never counts as spend.
 * - A block throws `InferenceUnavailableError` (`reason: 'entitlement'`)
 *   carrying the policy, cap, spend and reset time, after the caller writes
 *   one zero-usage `_smrt_ai_usage` row (`operation: 'blocked'`) through its
 *   own usage pipeline: the row is the audit record.
 *
 * Browser-safe and import-light.
 */

import type {
  InferenceRequest,
  InferenceResolution,
  InferenceTarget,
  InferenceTier,
  InferenceTierRequest,
  InferenceUsageRecord,
} from './inference.js';
import { inferenceUsageTags } from './inference.js';
import type { InferenceEntitlementDetails } from './inference-availability.js';
import { InferenceUnavailableError } from './inference-availability.js';

/** The `operation` of the audit row a blocked call writes. */
export const INFERENCE_BLOCKED_OPERATION = 'blocked';

/** What the gate is asked about one hosted call. */
export interface InferenceGateRequest {
  /** The tier the caller asked for (`auto` included). */
  tierRequested: InferenceTierRequest;
  /** The concrete tier the binding answered. */
  tier: InferenceTier;
  /** The `source: 'hosted'` target about to run (single or chain). */
  target: InferenceTarget;
  /** The request's tenant (the object's), when it named one. */
  tenantId?: string | null;
  /**
   * `null` for a client shared beyond one user (agents): the gate applies no
   * per-user cap. Otherwise the gate reads the ambient principal.
   */
  userId?: null;
  className?: string;
  promptKey?: string;
  /** True for a status probe: decide only (nothing will run). */
  probe?: boolean;
}

/** A gate's answer. Amounts are integer micro-dollars. */
export type InferenceGateDecision =
  | { action: 'allow' }
  | { action: 'warn'; details: InferenceEntitlementDetails }
  | { action: 'block'; details: InferenceEntitlementDetails };

/** The pre-call gate for hosted inference. */
export interface InferenceGate {
  check(request: InferenceGateRequest): Promise<InferenceGateDecision>;
}

const GATE_KEY = Symbol.for('smrt.inference.gate');

type GateHolder = { [GATE_KEY]?: InferenceGate };

/**
 * Register the process-wide hosted inference gate, or pass `undefined` to
 * remove it. Stored on `globalThis` like the resolver, so duplicate core
 * copies and HMR share it.
 */
export function setInferenceGate(gate: InferenceGate | undefined): void {
  const holder = globalThis as GateHolder;
  if (gate === undefined) delete holder[GATE_KEY];
  else holder[GATE_KEY] = gate;
}

/** The registered hosted inference gate, if any. */
export function getInferenceGate(): InferenceGate | undefined {
  return (globalThis as GateHolder)[GATE_KEY];
}

/**
 * True when `target` is bound to hosted inference: a `single` target, or a
 * chain a resolver stamped `source: 'hosted'` as a whole (its candidates
 * carry no source of their own, so the chain is gated once, before its
 * client is built).
 */
export function isHostedInferenceTarget(
  target: InferenceTarget | undefined,
): target is InferenceTarget {
  return target !== undefined && target.source === 'hosted';
}

function isMicros(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Copy the known fields of a gate's details, dropping anything malformed. */
function cleanDetails(details: unknown): InferenceEntitlementDetails | null {
  if (!details || typeof details !== 'object') return null;
  const raw = details as Record<string, unknown>;
  if (typeof raw.policy !== 'string' || raw.policy.trim() === '') return null;
  const clean: InferenceEntitlementDetails = { policy: raw.policy };
  if (isMicros(raw.cap)) clean.cap = raw.cap as number;
  if (isMicros(raw.spend)) clean.spend = raw.spend as number;
  if (
    typeof raw.resetsAt === 'string' &&
    !Number.isNaN(Date.parse(raw.resetsAt))
  ) {
    clean.resetsAt = raw.resetsAt;
  }
  if (raw.disabledBy === 'global' || raw.disabledBy === 'tenant') {
    clean.disabledBy = raw.disabledBy;
  }
  return clean;
}

const GATE_ERROR: InferenceEntitlementDetails = Object.freeze({
  policy: 'gate-error',
});

/**
 * Ask the gate about one call. Returns `allow` without consulting anything
 * for a target that is not hosted or when no gate is registered. A throwing
 * gate, or an answer that is not a well-formed decision, is a `block` with
 * policy `gate-error` (fail closed). Never throws.
 */
export async function checkInferenceGate(
  request: InferenceGateRequest,
  gate: InferenceGate | undefined = getInferenceGate(),
): Promise<InferenceGateDecision> {
  if (!isHostedInferenceTarget(request.target) || !gate) {
    return { action: 'allow' };
  }
  let decision: unknown;
  try {
    decision = await gate.check(request);
  } catch {
    return { action: 'block', details: GATE_ERROR };
  }
  const action = (decision as { action?: unknown } | null)?.action;
  if (action === 'allow') return { action: 'allow' };
  if (action === 'warn' || action === 'block') {
    const details = cleanDetails((decision as { details?: unknown }).details);
    if (details) return { action, details };
  }
  return { action: 'block', details: GATE_ERROR };
}

/** Build the gate request for a resolved tier call. */
export function inferenceGateRequest(
  request: InferenceRequest,
  resolution: InferenceResolution,
  target: InferenceTarget = resolution.target,
): InferenceGateRequest {
  return {
    tierRequested: request.tier,
    tier: resolution.tierResolved,
    target,
    ...(request.tenantId !== undefined ? { tenantId: request.tenantId } : {}),
    ...(request.userId === null ? { userId: null } : {}),
    ...(request.className ? { className: request.className } : {}),
    ...(request.promptKey ? { promptKey: request.promptKey } : {}),
  };
}

/**
 * The zero-usage audit row for a blocked call: `operation: 'blocked'`, the
 * tier tags (so `ai:usage --by tier` buckets it), `source: hosted`, and the
 * tags `reason` (`entitlement`), `policy`, and when known `cap`, `spend`
 * (micro-dollars) and `resetsAt`.
 */
export function inferenceBlockedUsageRecord(
  request: InferenceGateRequest,
  details: InferenceEntitlementDetails,
  resolution?: InferenceResolution,
): InferenceUsageRecord {
  const tierTags = resolution
    ? inferenceUsageTags(request.tierRequested, resolution)
    : { tierRequested: request.tierRequested, tierResolved: request.tier };
  return {
    ...(typeof request.target.provider === 'string'
      ? { provider: request.target.provider }
      : {}),
    ...(typeof request.target.model === 'string'
      ? { model: request.target.model }
      : {}),
    operation: INFERENCE_BLOCKED_OPERATION,
    duration: 0,
    tags: {
      ...tierTags,
      ...(request.promptKey ? { promptKey: request.promptKey } : {}),
      source: 'hosted',
      reason: 'entitlement',
      policy: details.policy,
      ...(details.cap !== undefined ? { cap: String(details.cap) } : {}),
      ...(details.spend !== undefined ? { spend: String(details.spend) } : {}),
      ...(details.resetsAt ? { resetsAt: details.resetsAt } : {}),
      ...(details.disabledBy ? { disabledBy: details.disabledBy } : {}),
    },
  };
}

/**
 * Run the gate for one call and enforce a block: record the audit row with
 * `record` (failures are swallowed: recording never masks the block), then
 * throw `InferenceUnavailableError` (`reason: 'entitlement'`). Returns the
 * decision for `allow` and `warn`.
 */
export async function enforceInferenceGate(
  request: InferenceGateRequest,
  options: {
    record?: (row: InferenceUsageRecord) => Promise<void> | void;
    resolution?: InferenceResolution;
    owner?: string;
    gate?: InferenceGate;
  } = {},
): Promise<InferenceGateDecision> {
  const decision = await checkInferenceGate(
    request,
    'gate' in options ? options.gate : getInferenceGate(),
  );
  if (decision.action !== 'block') return decision;
  if (options.record && !request.probe) {
    try {
      await options.record(
        inferenceBlockedUsageRecord(
          request,
          decision.details,
          options.resolution,
        ),
      );
    } catch {
      // The block stands even when the audit row cannot be written.
    }
  }
  throw new InferenceUnavailableError({
    reason: 'entitlement',
    mode: 'hosted',
    tier: request.tier,
    entitlement: decision.details,
    ...(options.owner ? { owner: options.owner } : {}),
  });
}
