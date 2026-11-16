/**
 * The product rules of the AI run model (#5005), in one place.
 *
 * `docs/content/ai-runs.md` once listed six product decisions as open, each
 * with two options. The owner has decided all six and the page now states
 * them as rules; the constants below record the decided value of each, so a
 * reader that reports the rules (or a test that pins them) has one source.
 * None of them is a switch: code implements the rule, and changing one is a
 * change to the page first.
 *
 * Constants only: nothing here reads a database or a setting.
 */

/**
 * Cancelling (page section 2): `cancelled` is a final status, never resumed
 * and never retried; a resumable pause is a `stopped` run with reason
 * `interrupted`, whether a host, a person or a shutdown asked for it.
 */
export const AI_RUN_CANCEL_POLICY = 'final-with-interrupted' as const;

/**
 * A failed workflow run (page sections 2 and 7): never resumed in place; a
 * host may retry it from its last accepted step as a new durable run that
 * names it in `retry_of_run_id`. The failed run's checkpoint is kept for as
 * long as its row.
 */
export const AI_RUN_FAILED_WORKFLOW_RETRY = 'from-last-accepted-step' as const;

/**
 * A call whose model has no price, under `maxCost` (page section 6.3): always
 * allowed, counted as uncosted (`uncosted_calls`), and not bounded by the
 * cost limit.
 */
export const AI_RUN_UNCOSTED_UNDER_MAX_COST = 'allow' as const;

/**
 * Waiting for approval (page section 6.7): only a durable run may move to
 * `waiting-approval`; a chat turn records the requested approval and ends.
 */
export const AI_RUN_APPROVAL_WAIT = 'durable-only' as const;

/**
 * Usage persistence off (page section 3): opening a run of any type fails
 * with `AiRunTrackingDisabledError` before any call is sent.
 */
export const AI_RUN_PERSISTENCE_OFF = 'required' as const;

/**
 * An unprotected run row (page section 8): pruned with its usage rows once
 * the usage age limit passes, counted from its `finished_at`.
 */
export const AI_RUN_UNPROTECTED_ROWS = 'prune-with-usage' as const;

/** All six rules, for a reader that reports them. */
export const AI_RUN_POLICY: Readonly<{
  cancel: typeof AI_RUN_CANCEL_POLICY;
  failedWorkflowRetry: typeof AI_RUN_FAILED_WORKFLOW_RETRY;
  uncostedUnderMaxCost: typeof AI_RUN_UNCOSTED_UNDER_MAX_COST;
  approvalWait: typeof AI_RUN_APPROVAL_WAIT;
  persistenceOff: typeof AI_RUN_PERSISTENCE_OFF;
  unprotectedRows: typeof AI_RUN_UNPROTECTED_ROWS;
}> = Object.freeze({
  cancel: AI_RUN_CANCEL_POLICY,
  failedWorkflowRetry: AI_RUN_FAILED_WORKFLOW_RETRY,
  uncostedUnderMaxCost: AI_RUN_UNCOSTED_UNDER_MAX_COST,
  approvalWait: AI_RUN_APPROVAL_WAIT,
  persistenceOff: AI_RUN_PERSISTENCE_OFF,
  unprotectedRows: AI_RUN_UNPROTECTED_ROWS,
});
