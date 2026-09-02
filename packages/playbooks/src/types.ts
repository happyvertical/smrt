import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type {
  CapabilityClassification,
  CapabilityDeclaration,
} from '@happyvertical/smrt-types';

/**
 * Execution planes a playbook can declare validity for.
 *
 * `browser` covers WebMCP / in-page agents driving mounted surfaces;
 * `server` covers Node MCP, CLI, and in-app agents running under
 * `executeAsPrincipal`.
 */
export type PlaybookPlane = 'browser' | 'server';

export const PLAYBOOK_PLANES: readonly PlaybookPlane[] = Object.freeze([
  'browser',
  'server',
]);

/**
 * A step naming a model operation by qualified pair — the same qualified
 * form STI discriminators and `@crossPackageRef` already use. Never a
 * generated tool name: that is derived from model, action, and namespace and
 * would silently orphan stored tenant overrides on a namespace change.
 *
 * The step never classifies itself; classification is inherited from the
 * referenced operation (see {@link PlaybookOperationClassifier}).
 */
export interface PlaybookOperationStep {
  kind: 'operation';
  /** Qualified model name, e.g. `@happyvertical/smrt-commerce:Order`. */
  model: string;
  /** Operation name exposed by the model's `@smrt({ api })` surface. */
  action: string;
  /** Human-facing label for the agent's narration of this step. */
  label?: string;
  /** Longer human-facing description of the step. */
  description?: string;
  /** When true, an agent may skip this step without abandoning the plan. */
  optional?: boolean;
}

/**
 * A step naming a declared view intent by its identity (#2588). Valid only
 * where a surface is mounted.
 */
export interface PlaybookIntentStep {
  kind: 'intent';
  /** Declared intent identity from the #2588 intent registry. */
  id: string;
  label?: string;
  description?: string;
  optional?: boolean;
}

/** A playbook step. Exactly two kinds exist in v1; playbooks cannot nest. */
export type PlaybookStep = PlaybookOperationStep | PlaybookIntentStep;

/**
 * What an agent does when a step fails partway through a plan. Playbooks are
 * scripts, never atomic units, so there is no compensation: the definition
 * says only whether the remainder of the plan is abandoned.
 */
export type PlaybookFailurePolicy = 'abort' | 'continue';

/**
 * Fields a stored override layer may change when the definition opts in.
 *
 * `steps` is deliberately absent: it is structurally non-editable, not merely
 * defaulted false. No override layer can carry a step list at all.
 */
export interface PlaybookEditableConfig {
  title: boolean;
  description: boolean;
  planes: boolean;
  onStepFailure: boolean;
  enabled: boolean;
  metadata: boolean;
}

export type PlaybookMetadata = Record<string, unknown>;

export interface PlaybookDefinitionInput {
  key: string;
  title: string;
  description: string;
  steps: readonly PlaybookStep[];
  /**
   * Planes this playbook is valid on. Defaults to both planes when every step
   * is a model operation, and to `['browser']` when any step is a view intent
   * — server validity for an intent-bearing playbook rides the #2446 browser
   * command/ack bridge and must be declared explicitly.
   */
  planes?: readonly PlaybookPlane[];
  onStepFailure?: PlaybookFailurePolicy;
  enabled?: boolean;
  metadata?: PlaybookMetadata | null;
  editable?: Partial<PlaybookEditableConfig>;
}

export interface PlaybookDefinition {
  key: string;
  title: string;
  description: string;
  steps: readonly PlaybookStep[];
  planes: readonly PlaybookPlane[];
  onStepFailure: PlaybookFailurePolicy;
  enabled: boolean;
  metadata: PlaybookMetadata;
  editable: PlaybookEditableConfig;
}

/**
 * A partial override from any layer above the code default. There is no
 * `steps` key, and supplying one is rejected rather than ignored.
 */
export interface PlaybookConfigOverrideInput {
  title?: string | null;
  description?: string | null;
  planes?: readonly PlaybookPlane[] | null;
  onStepFailure?: PlaybookFailurePolicy | null;
  enabled?: boolean | null;
  metadata?: PlaybookMetadata | null;
  [key: string]: unknown;
}

export interface PlaybookPackageConfig {
  playbooks?: Record<string, PlaybookConfigOverrideInput>;
  [key: string]: unknown;
}

/** One normalized override layer. `null` means "clear"; `undefined` means "inherit". */
export interface PlaybookLayer {
  title?: string | null;
  description?: string | null;
  planes?: readonly PlaybookPlane[] | null;
  onStepFailure?: PlaybookFailurePolicy | null;
  enabled?: boolean | null;
  metadata?: PlaybookMetadata | null;
}

export interface PlaybookOverrideOptions {
  key?: string;
  tenantId?: string | null;
  title?: string | null;
  description?: string | null;
  planes?: string | readonly PlaybookPlane[] | null;
  onStepFailure?: PlaybookFailurePolicy | null;
  enabled?: boolean | null;
  metadata?: string | PlaybookMetadata | null;
}

/**
 * Resolves the capability classification of a referenced model operation.
 *
 * Playbooks never classify a step themselves. A host that knows the emitted
 * build-time classification (core's `tool-schema.ts` output, or the runtime
 * manifest) supplies it here; anything it does not know resolves fail-closed
 * to `{ effect: 'destructive', idempotent: false, openWorld: true }`.
 */
export type PlaybookOperationClassifier = (
  step: PlaybookOperationStep,
) => CapabilityDeclaration | null | undefined;

/**
 * Record returned by an intent registry for a declared view intent.
 *
 * Seam for #2588: until an intent registry exists, no resolver is supplied and
 * an intent step fails resolution closed.
 */
export interface PlaybookIntentRecord {
  id: string;
  classification?: CapabilityDeclaration | null;
  planes?: readonly PlaybookPlane[] | null;
}

/** Seam for #2588. */
export type PlaybookIntentResolver = (
  id: string,
) => PlaybookIntentRecord | null | undefined;

export interface ResolvePlaybookOptions {
  db?: SmrtClassOptions['db'];
  tenantId?: string | null;
  /** Plane the calling agent runs on. Defaults to `'server'`. */
  plane?: PlaybookPlane;
  /** Highest-precedence layer, supplied per call. */
  override?: PlaybookConfigOverrideInput;
  /** Host-supplied classification source for model-operation steps. */
  classifier?: PlaybookOperationClassifier;
  /** Host-supplied intent registry (#2588). */
  intents?: PlaybookIntentResolver;
}

/** One step of a resolved plan, with its inherited classification. */
export interface PlaybookPlanStep {
  index: number;
  step: PlaybookStep;
  classification: CapabilityClassification;
  /** True when the classification is the fail-closed default. */
  classificationDeclared: boolean;
}

/**
 * The output of resolution: a plan an agent follows step by step. Nothing in
 * this package executes a step, and the plan is not an authority boundary —
 * every step is authorized independently where it runs.
 */
export interface PlaybookPlan {
  key: string;
  title: string;
  description: string;
  plane: PlaybookPlane;
  planes: readonly PlaybookPlane[];
  onStepFailure: PlaybookFailurePolicy;
  metadata: PlaybookMetadata;
  steps: readonly PlaybookPlanStep[];
}

export type PlaybookRejectionReason =
  | 'unknown-playbook'
  | 'disabled'
  | 'plane-not-declared'
  | 'intent-registry-unavailable'
  | 'unknown-intent'
  | 'intent-plane-not-declared';

export interface PlaybookRejection {
  ok: false;
  reason: PlaybookRejectionReason;
  message: string;
  key: string;
  /** Index of the offending step, when the rejection is step-scoped. */
  stepIndex?: number;
}

export interface PlaybookAcceptance {
  ok: true;
  plan: PlaybookPlan;
}

/** Resolution fails closed: every rejection carries a specific reason. */
export type PlaybookResolution = PlaybookAcceptance | PlaybookRejection;

export interface PlaybookCacheValue {
  key: string;
  title: string;
  description: string;
  planes: readonly PlaybookPlane[];
  onStepFailure: PlaybookFailurePolicy;
  enabled: boolean;
  metadata: PlaybookMetadata;
}
