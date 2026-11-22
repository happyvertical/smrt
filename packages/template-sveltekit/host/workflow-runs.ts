import { createHash, randomUUID } from 'node:crypto';
import {
  type AiRunBudget,
  type AiRunContext,
  aiRunStoppedError,
  createTrackedAiClient,
  getAiRun,
  getRunTrajectory,
  type InferenceTier,
  isReasoningEffort,
  listAiRuns,
  type ReasoningEffort,
} from '@happyvertical/smrt-core';
import type {
  CookbookToolDefinition,
  CookbookToolName,
  CookbookToolResult,
} from '@happyvertical/smrt-core/cookbook/tools';
import { stableStringify } from '@happyvertical/smrt-core/knowledge';
import type { InferenceEngineId } from '@happyvertical/smrt-inference/server';
import {
  definePrompt,
  type ResolvedPrompt,
  resolvePrompt,
} from '@happyvertical/smrt-prompts';
import {
  createWorkflowRunJobs,
  type WorkflowCheckContext,
  type WorkflowDefinition,
  type WorkflowRunState,
  type WorkflowStep,
  type WorkflowStepCheck,
} from '@happyvertical/smrt-workflows';
import type { DatabaseInterface } from '@happyvertical/sql';
import Ajv, { type ValidateFunction } from 'ajv/dist/2020.js';

/**
 * How a workflow run's steps run (#5005): the engine, the tier the change
 * asks for and the model the engine's tier binding chose for it, the effort,
 * and the owner's preview setting captured when the run started.
 */
export interface WorkflowRunExecution {
  engine: InferenceEngineId;
  tier: InferenceTier;
  model?: string;
  effort?: ReasoningEffort;
  previewBeforeApply: boolean;
}

/**
 * The cookbook change workflow's budget (#5005): the run's steps, tokens,
 * time and repairs, and each step turn's tool-loop steps, per-call output,
 * tokens, reply time and kept tool result size.
 */
export interface WorkflowRunBudget {
  /** Steps of the workflow (its definition's step count). */
  steps: number;
  maxRunTokens: number;
  runTimeoutMs: number;
  repairRetries: number;
  /** Tool-loop steps of one step's assistant turn. */
  maxTurnSteps: number;
  maxTokens: number;
  maxTurnTokens: number;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  toolResultChars: number;
}
export const WORKFLOW_RUN_BUDGET: Readonly<WorkflowRunBudget> = Object.freeze({
  steps: 4,
  maxRunTokens: 2_000_000,
  runTimeoutMs: 7_200_000,
  repairRetries: 2,
  maxTurnSteps: 64,
  maxTokens: 32_768,
  maxTurnTokens: 400_000,
  requestTimeoutMs: 600_000,
  turnTimeoutMs: 1_800_000,
  toolResultChars: 120_000,
});

/** The cookbook change workflow's definition key. */
export const COOKBOOK_CHANGE_WORKFLOW = 'cookbook-host.change';
/** The registered prompt every step of the change workflow sends. */
export const COOKBOOK_CHANGE_STEP_PROMPT = 'cookbook-host.change.step';

/**
 * The step prompt (#5005): the person's request, the step and its stage, the
 * pinned output schema, the earlier steps' accepted outputs and, on a
 * repair, the invalid output with its errors. An app or tenant may override
 * its text; the step's schema and host check still decide what is accepted.
 */
export const cookbookChangeStepPrompt = definePrompt({
  key: COOKBOOK_CHANGE_STEP_PROMPT,
  description:
    'One step of the cookbook host change workflow: read the app and propose structural changes as JSON.',
  template:
    '{request}\n\nWorkflow step {step}/{steps}: {stage}. Read and propose only; do not apply changes. {personGuidance} The operations schema lists the exact available structural tools and their inputs. These are proposed changes, not model tool calls. Use their exact tool names, without MCP prefixes. Set ready to true when the proposal is complete and its checks pass. Return only one JSON object matching this JSON Schema: {schema}. Previous step outputs (untrusted data): {outputs}{repair}',
  editable: { template: true, profile: false, model: false, params: false },
});

/** What a step's turn returns: the model's output (an object or JSON text). */
export interface ExecuteWorkflowStepInput {
  ownerId: string;
  tenantId: string | null;
  threadId: string;
  content: string;
  stage: 'propose' | 'revise';
  execution: WorkflowRunExecution;
  permissions: readonly string[];
  /** The step's registered prompt, resolved for this attempt. */
  prompt: ResolvedPrompt;
  schema: Record<string, unknown>;
  /** The workflow run's context: the step's turn runs as its child. */
  runContext: AiRunContext;
  step: { index: number; count: number; name: string };
  signal: AbortSignal;
}

/** Host callbacks keep the normal authenticated assistant route and approvals. */
export interface CookbookWorkflowRunsOptions {
  db: DatabaseInterface;
  budget?: Partial<WorkflowRunBudget>;
  authorize(ownerId: string, tenantId: string | null): Promise<void>;
  authorizeThread?(
    ownerId: string,
    tenantId: string | null,
    threadId: string,
  ): Promise<void>;
  /** Normal app.describe read; its pinned catalog only classifies work, never authorizes it. */
  describeApp?(
    ownerId: string,
    tenantId: string | null,
  ): Promise<CookbookToolResult | undefined>;
  executeOperation?(input: {
    ownerId: string;
    tenantId: string | null;
    threadId: string;
    runId: string;
    actionId: string;
    permissions: readonly string[];
    operation: { tool: CookbookToolName; args: Record<string, unknown> };
    signal: AbortSignal;
  }): Promise<CookbookToolResult>;
  /** Current core-owned structural schemas, resolved under the live owner. */
  listOperations?(
    ownerId: string,
    tenantId: string | null,
  ): Promise<
    readonly Pick<
      CookbookToolDefinition,
      'name' | 'inputSchema' | 'description'
    >[]
  >;
  /** Run one step as an assistant turn (a child run of the workflow run). */
  executeStep(input: ExecuteWorkflowStepInput): Promise<unknown>;
}

/** Wire progress of a workflow run; names and notes are the host's own. */
export interface CookbookWorkflowProgress {
  runId: string;
  step: { index: number; count: number; name: string };
  status:
    | 'running'
    | 'checking'
    | 'waiting-approval'
    | 'stopped'
    | 'failed'
    | 'done';
  note?: string;
}

interface Operation {
  tool: string;
  args: Record<string, unknown>;
}
interface Proposal {
  summary: string;
  personSummary: string;
  checks: string[];
  ready: boolean;
  operations: Operation[];
}
interface ListCatalog {
  revision: number;
  lists: Array<{ id: string; label: string; synonyms: string[] }>;
}

/** The run input: durable, never a credential or a captured Request. */
export interface CookbookWorkflowInput {
  threadId: string;
  content: string;
  execution: WorkflowRunExecution;
  /** The original authenticated permission ceiling; never model supplied. */
  permissions: string[];
  /** The app set its own step count: no adaptive early finish. */
  fixedSteps: boolean;
  listCatalog?: ListCatalog;
  /** The output schema pinned at start (live owner operations). */
  schema: Record<string, unknown>;
  schemaPin: string;
  /** The work needs more than the first step. */
  expanded?: boolean;
  previousCheck?: Record<string, unknown>;
  pendingApprovalId?: string;
  results?: CookbookToolResult[];
}

const NEEDS_INFORMATION =
  'No changes were applied. The change needs more information before it can propose a supported change.';

const outputSchema = {
  type: 'object',
  required: ['summary', 'checks', 'ready', 'operations', 'personSummary'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string', minLength: 1 },
    checks: { type: 'array', items: { type: 'string', minLength: 1 } },
    ready: { type: 'boolean' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tool', 'args'],
        properties: {
          tool: { type: 'string', minLength: 1 },
          args: { type: 'object', additionalProperties: true },
        },
      },
    },
    personSummary: {
      type: 'string',
      minLength: 1,
      maxLength: 240,
      description:
        'A short plain-language explanation for the person. Never include implementation details. The host validates presentation separately; this field does not grant authority.',
    },
  },
};

const fingerprint = (value: unknown) =>
  createHash('sha256').update(stableStringify(value)).digest('hex');

/** The step's output schema with the live owner's exact operation schemas. */
function proposalSchema(
  operations: readonly Pick<
    CookbookToolDefinition,
    'name' | 'inputSchema' | 'description'
  >[],
): Record<string, unknown> {
  return {
    ...outputSchema,
    properties: {
      ...outputSchema.properties,
      operations: {
        ...outputSchema.properties.operations,
        description:
          'Proposed changes only. Use the exact tool names and arguments below; never MCP wire names or invented tools. Set ready to true when the proposal is complete and its checks pass.',
        items: operations.length
          ? {
              oneOf: operations.map((operation) => {
                const args = structuredClone(operation.inputSchema);
                if (args.properties && typeof args.properties === 'object')
                  delete (args.properties as Record<string, unknown>)
                    .approvalId;
                if (Array.isArray(args.required))
                  args.required = args.required.filter(
                    (key) => key !== 'approvalId',
                  );
                args.additionalProperties = false;
                return {
                  type: 'object',
                  additionalProperties: false,
                  required: ['tool', 'args'],
                  description: operation.description,
                  properties: { tool: { const: operation.name }, args },
                };
              }),
            }
          : false,
      },
    },
  };
}

/**
 * Whether a first-step proposal of small changes on one existing list may
 * finish the run after that step (adaptive work). Additive scalar, choice
 * and money fields, field rename/hide and list label rename qualify; any
 * unknown or ambiguous reference expands the work instead of guessing.
 */
function smallOneListChange(
  input: CookbookWorkflowInput,
  proposal: Proposal | undefined,
): boolean {
  const catalog = input.listCatalog;
  if (
    input.fixedSteps ||
    input.expanded ||
    !proposal?.ready ||
    !proposal.operations?.length ||
    !catalog?.lists?.length ||
    !Number.isSafeInteger(catalog.revision)
  )
    return false;
  const lists = catalog.lists.map((list) => ({ ...list }));
  let target: string | undefined;
  for (const [index, operation] of proposal.operations.entries()) {
    if (
      ![
        'app.addField',
        'app.renameField',
        'app.hideField',
        'app.renameList',
      ].includes(operation.tool) ||
      (operation.tool === 'app.addField' &&
        ![
          'text',
          'long text',
          'number',
          'date',
          'date-time',
          'yes/no',
          'choice',
          'money',
        ].includes(String(operation.args.kind))) ||
      operation.args.expectedRevision !== catalog.revision + index
    )
      return false;
    const exact = lists.filter(
      (list) =>
        list.id === operation.args.list || list.label === operation.args.list,
    );
    const matches = exact.length
      ? exact
      : lists.filter((list) =>
          list.synonyms.includes(String(operation.args.list)),
        );
    if (
      matches.length !== 1 ||
      (target !== undefined && target !== matches[0].id)
    )
      return false;
    target = matches[0].id;
    if (operation.tool === 'app.renameList') {
      if (
        typeof operation.args.label !== 'string' ||
        lists.some(
          (list) => list.id !== target && list.label === operation.args.label,
        )
      )
        return false;
      matches[0].label = operation.args.label;
    }
  }
  return true;
}

/**
 * Whether the run's current step is the one whose accepted proposal is
 * applied: the last step, or an adaptive first step.
 */
export function isCookbookApplyStep(
  state: Pick<WorkflowRunState, 'step' | 'phase' | 'input' | 'pending'>,
): boolean {
  if (state.phase !== 'check') return false;
  if (state.step.index === state.step.count) return true;
  return (
    state.step.index === 1 &&
    smallOneListChange(
      readInput(state.input),
      state.pending as Proposal | undefined,
    )
  );
}

function readExecution(value: unknown): WorkflowRunExecution | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.engine !== 'string' ||
    !['api', 'chatgpt', 'claude-code', 'codex'].includes(record.engine) ||
    (record.model !== undefined && typeof record.model !== 'string') ||
    (record.effort !== undefined && !isReasoningEffort(record.effort))
  )
    return undefined;
  return {
    engine: record.engine as InferenceEngineId,
    tier:
      typeof record.tier === 'string' &&
      ['cheap', 'good', 'great', 'best'].includes(record.tier)
        ? (record.tier as InferenceTier)
        : 'best',
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    ...(isReasoningEffort(record.effort) ? { effort: record.effort } : {}),
    previewBeforeApply: record.previewBeforeApply !== false,
  };
}

/** The validated run input. */
export function readInput(input: unknown): CookbookWorkflowInput {
  if (!input || typeof input !== 'object')
    throw new Error('Invalid workflow input');
  const value = input as Record<string, unknown>;
  const execution = readExecution(value.execution);
  if (
    typeof value.threadId !== 'string' ||
    !value.threadId ||
    typeof value.content !== 'string' ||
    !value.content.trim() ||
    !execution ||
    !Array.isArray(value.permissions) ||
    !value.permissions.every((permission) => typeof permission === 'string') ||
    !value.schema ||
    typeof value.schema !== 'object' ||
    typeof value.schemaPin !== 'string'
  )
    throw new Error('Invalid workflow input');
  return { ...(value as unknown as CookbookWorkflowInput), execution };
}

const NOTES: Record<CookbookWorkflowProgress['status'], string> = {
  running: 'I’m working through your request.',
  checking: 'I’m checking the proposed changes.',
  'waiting-approval': 'Your changes are ready for your review.',
  stopped: 'This work is paused.',
  failed: 'I couldn’t finish this request. Please try again.',
  done: 'This work is complete.',
};

/**
 * Public progress is host-owned: model prose, checkpoint notes and error
 * text stay private. Adaptive work shows one planned step until it expands.
 */
export function presentCookbookWorkflowRun(
  state: Readonly<WorkflowRunState>,
  needsInformation = false,
): CookbookWorkflowProgress {
  const input = readInput(state.input);
  const adaptive = !input.fixedSteps && !input.expanded;
  const status: CookbookWorkflowProgress['status'] =
    state.status === 'cancelled'
      ? 'stopped'
      : state.status === 'running' && state.phase === 'check'
        ? 'checking'
        : state.status;
  return {
    runId: state.id,
    status,
    step: {
      index: state.step.index,
      count: adaptive ? Math.max(1, state.step.index) : state.step.count,
      name:
        state.step.index === 1
          ? 'Planning your changes'
          : 'Checking the proposed changes',
    },
    note:
      status === 'failed' && needsInformation
        ? 'No changes were made. I need a little more information.'
        : NOTES[status],
  };
}

/**
 * The cookbook change workflow on smrt-workflows (#4994, #5005): one
 * `workflow` run per request, its steps run as named handler jobs with claim
 * fencing, each step an assistant turn (a child run) over the registered
 * step prompt, its output checked against the pinned schema and by the host
 * check, which applies the accepted proposal through the core cookbook
 * service and holds for the owner where the service requires it. Create it
 * once per database at startup, BEFORE the host's task runner starts
 * (creating it later throws); dispose it after the runner stops.
 */
export function createCookbookWorkflowRuns(
  options: CookbookWorkflowRunsOptions,
) {
  const budget: WorkflowRunBudget = {
    ...WORKFLOW_RUN_BUDGET,
    ...options.budget,
  };
  if (
    !Number.isSafeInteger(budget.steps) ||
    budget.steps < 1 ||
    budget.steps > 64
  )
    throw new Error('Workflow steps must be between 1 and 64');
  const count = budget.steps;
  const ajv = new Ajv({ strict: true, allErrors: true });
  const validators = new Map<string, ValidateFunction>();
  const validatorFor = (input: CookbookWorkflowInput) => {
    let validate = validators.get(input.schemaPin);
    if (!validate) {
      validate = ajv.compile(input.schema);
      validators.set(input.schemaPin, validate);
    }
    return validate;
  };
  const liveSchema = async (ownerId: string, tenantId: string | null) =>
    proposalSchema((await options.listOperations?.(ownerId, tenantId)) ?? []);
  const assertSchemaPin = async (
    ownerId: string,
    tenantId: string | null,
    input: CookbookWorkflowInput,
  ) => {
    if (fingerprint(await liveSchema(ownerId, tenantId)) !== input.schemaPin)
      throw new Error('The change schema changed; start a new workflow run');
  };

  const stepOf = (index: number): WorkflowStep => ({
    name: index === 0 ? 'Propose the change' : 'Check and revise the change',
    promptKey: COOKBOOK_CHANGE_STEP_PROMPT,
    schema: outputSchema,
    async execute(context) {
      const run = await getAiRun(options.db, context.runId);
      if (!run?.ownerId) throw new Error('Workflow run not found');
      const ownerId = run.ownerId;
      const tenantId = run.tenantId ?? null;
      await options.authorize(ownerId, tenantId);
      const input = readInput(context.input);
      await assertSchemaPin(ownerId, tenantId, input);
      const prompt = await resolvePrompt(COOKBOOK_CHANGE_STEP_PROMPT, {
        db: options.db,
        tenantId,
        variables: {
          request: input.content,
          step: String(context.step.index),
          steps: String(context.step.count),
          stage: index === 0 ? 'propose' : 'revise',
          personGuidance:
            'Keep personSummary short and plain for the person; put implementation reasoning in summary and checks, never in personSummary.',
          schema: JSON.stringify(input.schema),
          outputs: JSON.stringify(context.outputs),
          repair: context.repair
            ? `\nRepair this invalid output using the schema: ${JSON.stringify(context.repair)}`
            : '',
        },
      });
      try {
        return await options.executeStep({
          ownerId,
          tenantId,
          threadId: input.threadId,
          content: input.content,
          stage: index === 0 ? 'propose' : 'revise',
          execution: input.execution,
          permissions: input.permissions,
          prompt,
          schema: input.schema,
          runContext: context.runContext,
          step: context.step,
          signal: context.signal,
        });
      } catch (error) {
        // The step's turn stopped because the workflow run stopped (a limit,
        // a stop, a cancel): that is the run's stop, never a failed step.
        const current = await getAiRun(options.db, context.runId);
        if (current && current.status !== 'running')
          throw aiRunStoppedError(current);
        throw error;
      }
    },
    check: (output, context) => check(index, output, context),
  });

  async function check(
    index: number,
    output: unknown,
    context: WorkflowCheckContext,
  ): Promise<WorkflowStepCheck> {
    const run = await getAiRun(options.db, context.runId);
    if (!run?.ownerId) throw new Error('Workflow run not found');
    const ownerId = run.ownerId;
    const tenantId = run.tenantId ?? null;
    const input = readInput(context.input);
    // Mechanical validation is repeated after a crash before advancing.
    if (!validatorFor(input)(output))
      throw new Error('Stored workflow output failed validation');
    await assertSchemaPin(ownerId, tenantId, input);
    const plan = output as Proposal;
    const maximum = index === count - 1;
    const previousCheck = (extra: Record<string, unknown> = {}) => ({
      step: index + 1,
      ready: plan.ready,
      checked: true,
      ...extra,
    });
    if (maximum && !plan.ready) return { failure: NEEDS_INFORMATION };
    const apply =
      maximum || (index === 0 && smallOneListChange(input, plan as Proposal));
    if (!apply || !plan.ready || !plan.operations.length)
      return {
        input: { ...input, expanded: true, previousCheck: previousCheck() },
      };
    if (!options.executeOperation)
      throw new Error('Durable workflow application is unavailable');
    await options.authorize(ownerId, tenantId);
    await options.authorizeThread?.(ownerId, tenantId, input.threadId);
    const results: CookbookToolResult[] = [];
    for (const [action, operation] of plan.operations.entries()) {
      context.signal.throwIfAborted();
      if (!input.permissions.includes(operation.tool))
        throw new Error(
          'Workflow operation is outside its original permission ceiling',
        );
      const result = await options.executeOperation({
        ownerId,
        tenantId,
        threadId: input.threadId,
        runId: context.runId,
        actionId: String(action),
        permissions: input.permissions,
        operation: operation as {
          tool: CookbookToolName;
          args: Record<string, unknown>;
        },
        signal: context.signal,
      });
      if (result.status === 'approval_required') {
        if (typeof result.approvalId !== 'string')
          throw new Error('Workflow approval is unavailable');
        // One hold per gated action: the step passes only once every
        // action of the proposal applied (smrt-workflows counts the holds).
        return {
          waitingApproval: true,
          holdRef: `approval:${result.approvalId}`,
          note: result.summary,
          input: {
            ...input,
            pendingApprovalId: result.approvalId,
            previousCheck: previousCheck(),
            results,
          },
        };
      }
      if (result.status !== 'ok') {
        // These statuses are core planning questions before any hold or
        // effect. Never replan after a receipt, an approval, or an
        // uncertain throw.
        if (
          !maximum &&
          results.length === 0 &&
          context.approvals === 0 &&
          !input.pendingApprovalId &&
          ['collision', 'clarification_required'].includes(result.status)
        )
          return {
            input: {
              ...input,
              expanded: true,
              previousCheck: previousCheck({ status: result.status }),
            },
          };
        throw new Error(result.summary);
      }
      results.push(result);
    }
    const { pendingApprovalId: _settled, ...rest } = input;
    return {
      complete: true,
      input: { ...rest, previousCheck: previousCheck(), results },
    };
  }

  const definition: WorkflowDefinition = {
    key: COOKBOOK_CHANGE_WORKFLOW,
    // The step count is part of the definition: a run resumes only under
    // the count that started it.
    version: `1/steps-${count}`,
    steps: Array.from({ length: count }, (_, index) => stepOf(index)),
  };

  const jobs = createWorkflowRunJobs<CookbookWorkflowInput>({
    db: options.db,
    definition,
    queue: 'default',
    authorize: async (owner) =>
      options.authorize(owner.ownerId, owner.tenantId),
    resumeBudget: async (_owner, _state, proposed) => ({
      ...proposed,
      maxTokens: Math.min(
        proposed.maxTokens ?? budget.maxRunTokens,
        budget.maxRunTokens,
      ),
      maxDurationMs: Math.min(
        proposed.maxDurationMs ?? budget.runTimeoutMs,
        budget.runTimeoutMs,
      ),
    }),
    configure: (owner, input) => {
      // Every step validates against the schema pinned when the run started
      // (the live owner's operation schemas then), also after a restart.
      const validate = validatorFor(readInput(input));
      return {
        ai: createTrackedAiClient({
          db: options.db,
          tenantId: owner.tenantId,
        }),
        validate: (_schema, output) =>
          validate(output)
            ? []
            : (validate.errors ?? []).map(
                (error) => `${error.instancePath || '/'} ${error.message}`,
              ),
      };
    },
  });

  return {
    budget,
    definition,
    /** Forget the definition; stop the task runner first. */
    dispose: () => jobs.dispose(),
    forOwner(ownerId: string, tenantId: string | null) {
      const runs = jobs.forOwner(ownerId, tenantId);
      const needsInformation = async (state: WorkflowRunState) => {
        if (state.status !== 'failed' || state.stopReason !== 'check_failed')
          return false;
        const checks = (
          (await getRunTrajectory(options.db, state.id, { tenantId }))
            ?.entries ?? []
        )
          .map((entry) => entry.event)
          .filter((event) => event?.type === 'check');
        const last = checks.at(-1)?.payload as
          | { failure?: unknown }
          | null
          | undefined;
        return last?.failure === NEEDS_INFORMATION;
      };
      const present = async (state: WorkflowRunState) =>
        presentCookbookWorkflowRun(state, await needsInformation(state));
      return {
        present,
        async start(input: {
          threadId: string;
          content: string;
          execution: WorkflowRunExecution;
          /** Captured authenticated permission ceiling; never model supplied. */
          permissions?: readonly string[];
          /** The app set its own step count. */
          fixedSteps?: boolean;
        }) {
          await options.authorize(ownerId, tenantId);
          const description =
            input.fixedSteps !== true
              ? await options.describeApp?.(ownerId, tenantId)
              : undefined;
          const lists =
            Array.isArray(description?.lists) && description.lists.length <= 512
              ? description.lists.flatMap((value: unknown) => {
                  if (!value || typeof value !== 'object') return [];
                  const list = value as Record<string, unknown>;
                  return typeof list.id === 'string' &&
                    list.id.length <= 512 &&
                    typeof list.label === 'string' &&
                    list.label.length <= 120 &&
                    Array.isArray(list.synonyms) &&
                    list.synonyms.length <= 32 &&
                    list.synonyms.every(
                      (alias: unknown) =>
                        typeof alias === 'string' && alias.length <= 120,
                    )
                    ? [
                        {
                          id: list.id,
                          label: list.label,
                          synonyms: [...list.synonyms] as string[],
                        },
                      ]
                    : [];
                })
              : [];
          // Never truncate away an ambiguous target: an incomplete bounded
          // snapshot disables the adaptive finish for this run.
          const listCatalog =
            description?.status === 'ok' &&
            Number.isSafeInteger(description.revision) &&
            Array.isArray(description.lists) &&
            lists.length === description.lists.length
              ? { revision: description.revision as number, lists }
              : undefined;
          const schema = await liveSchema(ownerId, tenantId);
          const runInput: CookbookWorkflowInput = {
            threadId: input.threadId,
            content: input.content,
            execution: input.execution,
            permissions: [...(input.permissions ?? [])],
            fixedSteps: input.fixedSteps === true,
            ...(listCatalog ? { listCatalog } : {}),
            schema,
            schemaPin: fingerprint(schema),
          };
          readInput(runInput);
          return runs.start({
            key: randomUUID(),
            input: runInput,
            tags: { threadId: input.threadId },
            budget: {
              maxSteps: count,
              maxTokens: budget.maxRunTokens,
              maxDurationMs: budget.runTimeoutMs,
              maxCallTokens: budget.maxTurnTokens,
              callTimeoutMs: budget.turnTimeoutMs,
              repairRetries: budget.repairRetries,
            } satisfies AiRunBudget,
          });
        },
        /** The newest run of a thread (of this owner's newest 100). */
        async latest(threadId: string) {
          await options.authorize(ownerId, tenantId);
          const listed = await listAiRuns(options.db, {
            type: 'workflow',
            definitionKey: COOKBOOK_CHANGE_WORKFLOW,
            tenantId,
            limit: 100,
          });
          // Newest first; the owner and thread are on the run row itself.
          for (const listedRun of listed) {
            const run = await getAiRun(options.db, listedRun.id);
            if (run?.ownerId === ownerId && run.tags.threadId === threadId)
              return runs.get(run.id);
          }
          return null;
        },
        get: (id: string) => runs.get(id),
        /**
         * Check a saved action against the run's accepted proposal before
         * the core service executes or replays it.
         */
        async validateAction(
          id: string,
          actionId: string,
          tool: string,
          args: Record<string, unknown>,
        ) {
          const state = await runs.get(id);
          const input = readInput(state.input);
          const output = state.pending as Proposal | null;
          if (
            !isCookbookApplyStep(state) ||
            !['waiting-approval', 'running', 'stopped'].includes(
              state.status,
            ) ||
            !validatorFor(input)(output) ||
            !output?.ready ||
            !/^(0|[1-9]\d*)$/.test(actionId)
          )
            throw new Error('Saved workflow action changed');
          await assertSchemaPin(ownerId, tenantId, input);
          const operation = output.operations[Number(actionId)];
          const desired =
            operation?.tool === 'cookbook.apply'
              ? { ...operation.args, apply: true }
              : operation?.args;
          if (
            !operation ||
            operation.tool !== tool ||
            !input.permissions.includes(tool) ||
            fingerprint(desired) !== fingerprint(args)
          )
            throw new Error('Saved workflow arguments changed');
          await options.authorizeThread?.(ownerId, tenantId, input.threadId);
        },
        stop: (id: string) => runs.stop(id),
        /**
         * Resume a stopped run (raising its limits within the app's), or
         * recover a run whose worker died.
         */
        async resume(id: string, raise?: AiRunBudget) {
          const state = await runs.get(id);
          return state.status === 'running'
            ? runs.resume(id)
            : runs.resume(id, raise);
        },
        /**
         * Carry an owner decision on the run's pending native hold into the
         * run: approved (or approved and deferred while stopped) re-runs the
         * check, which replays the held action once; denied, failed or
         * expired fails the step. Harmless to repeat.
         */
        async settleHold(
          id: string,
          record: { id: string; status: string } | null | undefined,
        ) {
          const state = await runs.get(id);
          const pending = readInput(state.input).pendingApprovalId;
          if (
            !record ||
            record.id !== pending ||
            !['waiting-approval', 'stopped'].includes(state.status)
          )
            return state;
          const approved = ['approved', 'executing', 'succeeded'].includes(
            record.status,
          );
          const refused = ['denied', 'failed', 'expired'].includes(
            record.status,
          );
          if (!approved && !refused) return state;
          try {
            return await runs.decide(id, { approved });
          } catch {
            // Already decided (a repeated read): the run carries it.
            return runs.get(id);
          }
        },
      };
    },
  };
}

/** The host's cookbook workflow runs. */
export type CookbookWorkflowRuns = ReturnType<
  typeof createCookbookWorkflowRuns
>;
