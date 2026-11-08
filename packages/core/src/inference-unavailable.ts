/**
 * The typed "AI is unavailable here" error (#4757 owns the contract; #4758
 * throws it with `reason: 'capability'`). Browser-safe: imports only the
 * import-free `SmrtError`.
 *
 * #4757 adds the other reasons' throw sites (`off`, `unconfigured`,
 * `entitlement`); the shape here matches its issue text so the two branches
 * reconcile without a contract change.
 */

import { SmrtError } from './smrt-error.js';

/** `SmrtError.code` of {@link InferenceUnavailableError}. */
export const AI_UNAVAILABLE = 'AI_UNAVAILABLE';

/**
 * Why inference is unavailable:
 *
 * - `off`: inference mode is `off` for this user or tenant (#4757).
 * - `unconfigured`: no provider anywhere (#4757).
 * - `entitlement`: the plan does not grant the feature (#4757, #4759).
 * - `capability`: the bound model cannot do what the operation requires,
 *   such as required tools on a text-only model (#4758).
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

/**
 * Thrown instead of an untyped failure when inference cannot run here. It is
 * never turned into an answer: `is()` throws it rather than returning
 * `false`. Nothing is recorded in `_smrt_ai_usage` for it: no model ran.
 */
export class InferenceUnavailableError extends SmrtError {
  readonly reason: InferenceUnavailableReason;

  constructor(
    reason: InferenceUnavailableReason,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, AI_UNAVAILABLE, 'ai', { ...(details ?? {}), reason });
    this.reason = reason;
  }
}

/** True for an {@link InferenceUnavailableError}, across core copies. */
export function isInferenceUnavailableError(
  error: unknown,
): error is InferenceUnavailableError {
  if (error instanceof InferenceUnavailableError) return true;
  const candidate = error as { code?: unknown; reason?: unknown } | null;
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    candidate.code === AI_UNAVAILABLE &&
    (INFERENCE_UNAVAILABLE_REASONS as readonly unknown[]).includes(
      candidate.reason,
    )
  );
}
