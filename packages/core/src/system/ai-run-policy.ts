/**
 * The open product decisions of the AI run model (#5005), in one place.
 *
 * `docs/content/ai-runs.md` states six decisions as two options each, **(a)**
 * and **(b)**, and does not choose between them. Code reads each answer from
 * the constant below, never from a literal, so settling one is a change to
 * this file and not a search. Every value is the page's option **(a)**; the
 * alternative is named beside it.
 *
 * Constants only: nothing here reads a database or a setting.
 */

/**
 * What a `cancelled` stop means (page section 2).
 *
 * - `resumable`: **(a)** `cancelled` is a resumable stop, whatever the
 *   host's reason, a person or a shutdown alike.
 * - `final-with-interrupted`: **(b)** `cancelled` is final, and a separate
 *   resumable `interrupted` stop is used when the host stops a run only
 *   because it is shutting down.
 */
export const AI_RUN_CANCEL_POLICY = 'resumable' as const;
export type AiRunCancelPolicy = 'resumable' | 'final-with-interrupted';

/**
 * How a host tries a `failed` workflow run again (page section 2).
 *
 * - `restart`: **(a)** always from the beginning, as a new run.
 * - `from-last-accepted-step`: **(b)** a host may retry it from its last
 *   accepted step, keeping the accepted outputs of the steps before it.
 */
export const AI_RUN_FAILED_WORKFLOW_RETRY = 'restart' as const;
export type AiRunFailedWorkflowRetry = 'restart' | 'from-last-accepted-step';

/**
 * A call whose model has no price, when `maxCost` applies (page section 6.3).
 *
 * - `refuse`: **(a)** the reservation is refused and the run stops with
 *   reason `uncosted`.
 * - `allow`: **(b)** the call is allowed as uncosted and the cost limit does
 *   not bound it.
 */
export const AI_RUN_UNCOSTED_UNDER_MAX_COST = 'refuse' as const;
export type AiRunUncostedUnderMaxCost = 'refuse' | 'allow';

/**
 * Which runs may wait for approval (page section 6.7).
 *
 * - `durable-only`: **(a)** only a durable run, because waiting needs a
 *   checkpoint to resume from.
 * - `in-process`: **(b)** a chat turn may also wait in memory, and the sweep
 *   treats a non-durable run left `waiting-approval` as one left `running`.
 */
export const AI_RUN_APPROVAL_WAIT = 'durable-only' as const;
export type AiRunApprovalWait = 'durable-only' | 'in-process';

/**
 * A fusion or chat turn on a database with usage persistence off (page
 * section 3).
 *
 * - `untracked`: **(a)** it runs, but no run is opened and asking for a
 *   budget is an error.
 * - `required`: **(b)** it is refused until persistence is turned on.
 */
export const AI_RUN_PERSISTENCE_OFF = 'untracked' as const;
export type AiRunPersistenceOff = 'untracked' | 'required';

/**
 * An unprotected run row, once the usage age limit passes (page section 8).
 * Protected rows (running, waiting, a resumable stop, in an experiment,
 * `retain` set) are never pruned either way.
 *
 * - `prune-with-usage`: **(a)** it is pruned by the usage age limit, with its
 *   usage rows, as fusion run rows are today.
 * - `keep`: **(b)** it is kept, and only its trajectory is pruned.
 */
export const AI_RUN_UNPROTECTED_ROWS = 'prune-with-usage' as const;
export type AiRunUnprotectedRows = 'prune-with-usage' | 'keep';

/** All six answers, for a reader that reports them. */
export const AI_RUN_POLICY: Readonly<{
  cancel: AiRunCancelPolicy;
  failedWorkflowRetry: AiRunFailedWorkflowRetry;
  uncostedUnderMaxCost: AiRunUncostedUnderMaxCost;
  approvalWait: AiRunApprovalWait;
  persistenceOff: AiRunPersistenceOff;
  unprotectedRows: AiRunUnprotectedRows;
}> = Object.freeze({
  cancel: AI_RUN_CANCEL_POLICY,
  failedWorkflowRetry: AI_RUN_FAILED_WORKFLOW_RETRY,
  uncostedUnderMaxCost: AI_RUN_UNCOSTED_UNDER_MAX_COST,
  approvalWait: AI_RUN_APPROVAL_WAIT,
  persistenceOff: AI_RUN_PERSISTENCE_OFF,
  unprotectedRows: AI_RUN_UNPROTECTED_ROWS,
});
