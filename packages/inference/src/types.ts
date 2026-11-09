/**
 * Public shapes of the chain executor (#4752). The config shapes
 * (`InferenceCandidate`, `InferenceAlias`, `InferenceTarget`) live in core,
 * which owns the names; this package owns the behavior.
 */

/**
 * Why a candidate did not answer. Classified from the SDK error class, its
 * code and the HTTP status through the cause chain, never from message text.
 *
 * - `quota`: billing or a rate limit that will not reset soon.
 * - `credential`: missing, rejected or unauthorized key.
 * - `missing-model`: the provider does not know the model.
 * - `transient`: timeout, network, 5xx, or a short rate limit; retried once.
 * - `refusal`: the provider's safety system or the model declined.
 * - `missing-capability`: the candidate lacks a capability the request
 *   needs (JSON mode, tools) and the caller permitted no fallback (#4758).
 *   Detected before the call, so no model ran; core's typed capability
 *   refusal classifies the same way.
 */
export const INFERENCE_FAILURE_CLASSES = [
  'quota',
  'credential',
  'missing-model',
  'transient',
  'refusal',
  'missing-capability',
] as const;

export type InferenceFailureClass = (typeof INFERENCE_FAILURE_CLASSES)[number];

/**
 * A substitution reason: the failure class that moved the call on, `partial`
 * for a candidate that streamed text and then failed, or `unclassified` for
 * the terminal entry of a call ended by an error that is not a routing
 * failure (rethrown as the caller's own error).
 */
export type InferenceSubstitutionReason =
  | InferenceFailureClass
  | 'partial'
  | 'unclassified';

/**
 * One step of a call's fallback trail, recorded in the `substitutions` usage
 * tag (a JSON array). `from` and `to` are candidate labels
 * (`provider/model`, `preset:<id>/model`, or `default` for the configured
 * client); `to` is `null` when nothing took over.
 */
export interface InferenceSubstitution {
  from: string;
  to: string | null;
  reason: InferenceSubstitutionReason;
}

/** One problem found in an `inference` config block. */
export interface InferenceConfigIssue {
  /** Dotted config path of the offender, e.g. `inference.aliases.frontier`. */
  path: string;
  code:
    | 'alias-empty'
    | 'alias-unknown'
    | 'alias-cycle'
    | 'candidate-invalid'
    | 'candidate-key-without-endpoint'
    | 'preset-unknown'
    | 'fusion-invalid'
    | 'fusion-unknown'
    | 'fusion-nested'
    | 'fusion-prompt-unknown';
  message: string;
}
