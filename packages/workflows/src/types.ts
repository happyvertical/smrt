import type {
  AiRunBudget,
  AiRunContext,
  AiRunStatus,
  AiRunStopDetail,
  AiRunStopReason,
} from '@happyvertical/smrt-core';

/** The run type every workflow run carries (docs/content/ai-runs.md). */
export const WORKFLOW_RUN_TYPE = 'workflow';

/** Version of {@link WorkflowCheckpointState}'s own shape. */
export const WORKFLOW_STATE_VERSION = 1;

/**
 * What a workflow run keeps in its checkpoint (the run type owns this
 * state; core wraps it in a versioned envelope): the step it is on, the
 * repair count, and the accepted outputs of the completed steps. Totals,
 * tokens and attempts are never here: the usage rows and events are the
 * record.
 */
export interface WorkflowCheckpointState {
  v: typeof WORKFLOW_STATE_VERSION;
  /** Zero-based index of the step the run is on. */
  stepIndex: number;
  /** `call`: the step's model call is next; `check`: its accepted output awaits the host check. */
  phase: 'call' | 'check';
  /** Repairs used on the current step (attempt = repairs + 1). */
  repairs: number;
  /** Times the host check asked to run the current step again. */
  repeats: number;
  /** The run input, when small enough to keep inline. */
  input: unknown;
  /** A pointer at input the host stores (large input passes by reference). */
  inputRef: string | null;
  /** Accepted outputs of the completed steps, by step index. */
  outputs: unknown[];
  /** The current step's accepted output, awaiting its check. */
  pending: { output: unknown; judgedEventId: string | null } | null;
  /** The current step's last invalid output, for the repair attempt. */
  invalid: { output: unknown; errors: string[] } | null;
  /** The approval (hold) requested for the pending output and not yet decided. */
  approval: { requestEventId: string } | null;
  /**
   * Holds of the current step a person approved so far. A step may hold
   * more than once (one hold per gated action); it passes only when its
   * check passes with no hold outstanding. Absent in older checkpoints: 0.
   */
  approvals?: number;
}

/** Host-facing progress; names are the host's plain text. */
export interface RunProgress {
  runId: string;
  /** One-based step position and the step's name. */
  step: { index: number; count: number; name: string };
  status: AiRunStatus;
  stopReason: AiRunStopReason | null;
  phase: WorkflowCheckpointState['phase'];
}

/** What a host check decides about a step's accepted output. */
export interface WorkflowStepCheck {
  /** Facts for the next step: replaces the run input. */
  input?: unknown;
  /**
   * The host finished the work at this step (it applied the accepted
   * output); the run ends `done` here without running later steps.
   */
  complete?: boolean;
  /**
   * A definitive rejection: the run ends `failed` with `check_failed`. A
   * safe, host-authored explanation; never model output or error text.
   */
  failure?: string;
  /** Run this step again (a new step instance), up to `maxRepeats`. */
  repeat?: boolean;
  /**
   * Pause for a person's decision (durable runs only). Every time a check
   * returns it, a new hold is requested (an `approval` event): a check that
   * holds again after an approval waits again, and the step passes only once
   * its check returns without it.
   */
  waitingApproval?: boolean;
  /**
   * What the hold points at in the host (`payload_ref` of the `approval`
   * request, e.g. `approval:<id>`), for mapping a host decision to the run.
   */
  holdRef?: string;
  /** A short host note recorded on the check or approval event. */
  note?: string;
}

/** What a step's call or check sees. */
export interface WorkflowStepContext {
  runId: string;
  step: { index: number; count: number; name: string };
  /** The run input (resolved from `inputRef` when passed by reference). */
  input: unknown;
  /** Accepted outputs of the completed steps. */
  outputs: readonly unknown[];
  /** 1 for the first try, 2 for the first repair, ... */
  attempt: number;
  /** The previous attempt's invalid output and its errors. */
  repair: { output: unknown; errors: readonly string[] } | null;
  signal: AbortSignal;
}

/** What a step's check sees. */
export interface WorkflowCheckContext extends WorkflowStepContext {
  /** Assert the current claim and running status before a repeat-safe host effect. */
  assertActive(): Promise<void>;
  /**
   * `approved` when the check runs again after a person approved the step's
   * latest hold; null otherwise. Asking for approval again requests a new
   * hold: it is never taken as passed.
   */
  approval: 'approved' | null;
  /** Holds of this step a person approved so far. */
  approvals: number;
}

/**
 * A step's own execution, replacing the default prompt call (a CLI engine,
 * say). It must send every model call it makes with `runContext`, so each
 * call is reserved, recorded and settled in this run, and return the step's
 * output (an object, or JSON text).
 */
export type WorkflowStepExecute = (
  request: WorkflowStepContext & { runContext: AiRunContext },
) => Promise<unknown>;

/**
 * One host-defined stage of a workflow. Model output cannot change it. By
 * default its call resolves the registered prompt `promptKey` through
 * `resolvePrompt` and sends it on the tracked client; the output must pass
 * `schema` (the host's full validator) and then the host `check`.
 */
export interface WorkflowStep {
  name: string;
  /** The registered prompt this step's call uses. */
  promptKey: string;
  schema: Record<string, unknown>;
  /**
   * The prompt's variables. Default: `input`, `outputs`, `schema`,
   * `repairOutput` and `repairErrors` as JSON or plain text.
   */
  variables?: (
    context: WorkflowStepContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Deterministic and safe to repeat: recovery may replay it. */
  check?: (
    output: unknown,
    context: WorkflowCheckContext,
  ) => WorkflowStepCheck | Promise<WorkflowStepCheck>;
  /** How many times the check may ask to repeat this step (default 0). */
  maxRepeats?: number;
  /** The output allowance a call of this step is reserved with. */
  expectedOutputTokens?: number;
  execute?: WorkflowStepExecute;
}

/**
 * A versioned list of steps (one workflow definition). A run resumes only
 * under the version that saved its checkpoint, unless this version declares
 * it accepts older checkpoints and validates or migrates them.
 */
export interface WorkflowDefinition {
  key: string;
  version: string;
  steps: readonly WorkflowStep[];
  olderCheckpoints?: {
    /** Whether a checkpoint saved by `version` is accepted. */
    accepts(version: string | null): boolean;
    /**
     * Validate an accepted older checkpoint's state and return it in this
     * version's shape; throw to refuse it (the run then stops with
     * `definition_changed`).
     */
    migrate(
      state: WorkflowCheckpointState,
      version: string | null,
    ): WorkflowCheckpointState;
  };
}

/** A workflow run as the host sees it. */
export interface WorkflowRunState {
  id: string;
  ownerId: string | null;
  tenantId: string | null;
  definitionKey: string | null;
  definitionVersion: string | null;
  status: AiRunStatus;
  stopReason: AiRunStopReason | null;
  stoppedByRunId: string | null;
  stopDetail: AiRunStopDetail | null;
  retryOfRunId: string | null;
  budget: AiRunBudget;
  /** The checkpoint revision this snapshot was read at. */
  revision: number;
  step: { index: number; count: number; name: string };
  phase: WorkflowCheckpointState['phase'];
  input: unknown;
  inputRef: string | null;
  outputs: unknown[];
  /** The current step's accepted output awaiting its check or approval. */
  pending: unknown;
  /** Spend so far, from the run row (own and inclusive of child runs). */
  totals: {
    tokens: number;
    calls: number;
    costUsed: number;
    stepsUsed: number;
    inclusiveTokens: number;
    inclusiveCalls: number;
    inclusiveCost: number;
  };
}
