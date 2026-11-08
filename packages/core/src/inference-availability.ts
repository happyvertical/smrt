/**
 * Inference mode and the typed "AI unavailable" state (#4757, epic #4666).
 *
 * A fresh install with no key, a user who switched AI off, or a hosted plan
 * without the entitlement is a normal state, not a failure. Every AI entry
 * point (`getAiClient()`, so `is()`, `do()`, `describe()` and `evaluate()`'s
 * generative route; raw-client sites through `resolveInferenceTarget()`)
 * throws {@link InferenceUnavailableError} (`AI_UNAVAILABLE`) before any
 * client is built, so nothing runs and nothing is recorded in
 * `_smrt_ai_usage`. UIs ask first through `isInferenceAvailable()` /
 * `getInferenceStatus()`, which return an {@link InferenceStatus}.
 *
 * Browser-safe and import-light: a settings page or chat surface can share
 * the status type and the error guard without loading the root entry.
 */

import { SmrtError } from './smrt-error.js';

/**
 * Where a principal's inference comes from: their own key (`byo`), a local
 * server (`local`), managed inference (`hosted`), or nothing (`off`).
 */
export const INFERENCE_MODES = ['byo', 'local', 'hosted', 'off'] as const;

/** One of {@link INFERENCE_MODES}. */
export type InferenceMode = (typeof INFERENCE_MODES)[number];

/** True for a known {@link InferenceMode}. */
export function isInferenceMode(value: unknown): value is InferenceMode {
  return (
    typeof value === 'string' &&
    (INFERENCE_MODES as readonly string[]).includes(value)
  );
}

/**
 * Why inference is unavailable.
 *
 * - `off`: the user or tenant chose mode `off`.
 * - `unconfigured`: no provider anywhere (no stored binding, no app config,
 *   no configured client), or an explicit mode with no binding of its kind.
 * - `entitlement`: reserved for the hosted spend/entitlement gate (#4760).
 * - `capability`: reserved for capability detection (#4758): the bound
 *   model cannot do what the call needs (JSON mode, tools).
 */
export const INFERENCE_UNAVAILABLE_REASONS = [
  'off',
  'unconfigured',
  'entitlement',
  'capability',
] as const;

/** One of {@link INFERENCE_UNAVAILABLE_REASONS}. */
export type InferenceUnavailableReason =
  (typeof INFERENCE_UNAVAILABLE_REASONS)[number];

/** True for a known {@link InferenceUnavailableReason}. */
export function isInferenceUnavailableReason(
  value: unknown,
): value is InferenceUnavailableReason {
  return (
    typeof value === 'string' &&
    (INFERENCE_UNAVAILABLE_REASONS as readonly string[]).includes(value)
  );
}

/** `SmrtError.code` of {@link InferenceUnavailableError}. */
export const AI_UNAVAILABLE = 'AI_UNAVAILABLE';

/** Tier names, repeated here so this module stays import-free. */
type StatusTier = 'cheap' | 'good' | 'great' | 'best';

/**
 * What a probe or an `inferenceStatus` endpoint returns. Never carries a
 * key, endpoint or model: only whether a call would run, and why not.
 */
export interface InferenceStatus {
  available: boolean;
  /** `off` whenever `reason` is `off` or `unconfigured`. */
  mode: InferenceMode;
  /** Set when `available` is false. */
  reason?: InferenceUnavailableReason;
  /** The concrete tier probed (`auto` resolved), when a tier was asked for. */
  tier?: StatusTier;
}

/** Details carried by {@link InferenceUnavailableError}. */
export interface InferenceUnavailableDetails {
  reason: InferenceUnavailableReason;
  /**
   * Always `off` for `off` / `unconfigured`; for `entitlement` / `capability`
   * the mode that was refused (default `off`).
   */
  mode?: InferenceMode;
  tier?: StatusTier;
  /** Names the caller (a class, a route) in the message. Never a secret. */
  owner?: string;
}

/** A short, user-safe sentence for each reason (no stack, no config). */
export function inferenceUnavailableMessage(
  reason: InferenceUnavailableReason,
): string {
  switch (reason) {
    case 'off':
      return 'AI is turned off.';
    case 'unconfigured':
      return 'AI is not set up: no AI provider is configured.';
    case 'entitlement':
      return 'AI is not included in the current plan.';
    case 'capability':
      return 'The configured AI model cannot do this.';
  }
}

/**
 * The typed "AI unavailable" state (`AI_UNAVAILABLE`). Not retryable: the
 * jobs runner honours `retryable: false`, and `ErrorUtils.isRetryable()`
 * reads the `configuration` category as permanent. `is()` never turns it
 * into `false`; ask {@link InferenceStatus} first for a soft answer.
 */
export class InferenceUnavailableError extends SmrtError {
  readonly reason: InferenceUnavailableReason;
  readonly mode: InferenceMode;
  readonly tier?: StatusTier;
  /** Read by the jobs runner: never retried. */
  readonly retryable = false;

  constructor(details: InferenceUnavailableDetails) {
    const mode =
      details.reason === 'off' || details.reason === 'unconfigured'
        ? 'off'
        : (details.mode ?? 'off');
    const prefix = details.owner ? `${details.owner}: ` : '';
    super(
      `${prefix}${inferenceUnavailableMessage(details.reason)}`,
      AI_UNAVAILABLE,
      'configuration',
      {
        reason: details.reason,
        mode,
        ...(details.tier ? { tier: details.tier } : {}),
      },
    );
    this.reason = details.reason;
    this.mode = mode;
    if (details.tier) this.tier = details.tier;
  }

  /** The {@link InferenceStatus} this error reports. */
  toStatus(): InferenceStatus {
    return inferenceUnavailableStatus(this.reason, this.mode, this.tier);
  }
}

/** An unavailable {@link InferenceStatus}. */
export function inferenceUnavailableStatus(
  reason: InferenceUnavailableReason,
  mode?: InferenceMode,
  tier?: StatusTier,
): InferenceStatus {
  return {
    available: false,
    mode:
      reason === 'off' || reason === 'unconfigured' ? 'off' : (mode ?? 'off'),
    reason,
    ...(tier ? { tier } : {}),
  };
}

/**
 * True for an {@link InferenceUnavailableError}, including one thrown by
 * another copy of core (duplicate installs, HMR): matched by `code` and a
 * known `reason`, never by message text.
 */
export function isInferenceUnavailableError(
  error: unknown,
): error is InferenceUnavailableError {
  if (error instanceof InferenceUnavailableError) return true;
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; reason?: unknown };
  return (
    record.code === AI_UNAVAILABLE &&
    isInferenceUnavailableReason(record.reason)
  );
}
