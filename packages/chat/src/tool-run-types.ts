/**
 * Which model answers a turn, which tools a chat `turn` run may call, and
 * what the turn does about a tool limited to workflow runs (#5005). Host
 * configuration only: none of it is ever read from request input or tool
 * arguments, and none of it changes execution authority.
 */
import type { AIMessage } from '@happyvertical/ai';
import type { InferenceTier, ReasoningEffort } from '@happyvertical/smrt-core';
import type {
  AssistantSettings,
  EngineExecution,
  InferenceEngineId,
} from '@happyvertical/smrt-inference';

/** The model of one assistant turn, chosen by the host's tier binding. */
export interface AssistantModelSelection {
  engine: InferenceEngineId;
  /** The tier the turn asks for. */
  tier: InferenceTier;
  /** The model the engine's tier binding chose; absent: the engine's own. */
  model?: string;
  /**
   * The tier binding's effort; the assistant prompt's `ai.effort` wins
   * over it. Absent: the engine's default.
   */
  effort?: ReasoningEffort;
}

/**
 * A chat `turn` run asked for a tool limited to other run types. The tool
 * has NOT executed. With `escalateToWorkflow` on and a host that starts
 * workflow runs (`onWorkflowEscalation`), the request is handed to a workflow
 * run; otherwise the turn ends with this refusal.
 */
export class ToolRunTypeRefusal extends Error {
  readonly code = 'tool_run_type';
  /** The conversation up to the refused call, for the workflow run. */
  messages?: AIMessage[];
  /** What the turn had used when it was refused. */
  execution?: EngineExecution;
  constructor(
    readonly tool: string,
    readonly runTypes: readonly string[],
  ) {
    super(`The tool ${tool} runs only in a workflow run.`);
    this.name = 'ToolRunTypeRefusal';
  }
}

/** Turn-local accounting that survives a handoff. Never serialized as authority. */
export const TURN_ACCOUNTING = Symbol('turnAccounting');
export interface TurnAccounting {
  model?: string;
  startedAt: number;
  tokens: number;
  usageKnown: boolean;
  toolCalls: number;
}

/** Server configuration only; never read these values from tool arguments. */
export interface AssistantRunTypeOptions {
  [TURN_ACCOUNTING]?: TurnAccounting;
  /** The engine and model of this turn, from the host's tier binding. */
  selection?: AssistantModelSelection;
  /** The owner's assistant settings; absent ones are on. */
  assistantSettings?: AssistantSettings;
  /** Known workflow request: hand it to the host before any model call. */
  deferWorkflowTurn?: boolean;
  /** App-owned tools limited to workflow runs, besides annotated ones. */
  workflowTools?: readonly string[];
  /** What the turn ran with and used, once it ends or hands off. */
  onExecution?(execution: EngineExecution): void;
  /** Trusted host presentation of structured pass output, before storing the reply. */
  formatAssistantReply?(content: string): {
    content: string;
    metadata?: Record<string, unknown>;
  };
  /** Host may start a workflow run for the request. The refused call never runs. */
  onWorkflowEscalation?(input: {
    tool: string;
    history: readonly AIMessage[];
    userMessage?: string;
    thread?: { id: string; roomId?: string; agentSessionId: string };
    originMessageId?: string;
  }): Promise<{ runId: string; message?: string }>;
}

/** The run types a tool may be called from; `undefined` is any. */
export function toolRunTypes(
  options: Pick<AssistantRunTypeOptions, 'workflowTools'>,
  tool: { slug: string; annotations?: { runTypes?: readonly string[] } },
): readonly string[] | undefined {
  return (
    tool.annotations?.runTypes ??
    (options.workflowTools?.includes(tool.slug) ? ['workflow'] : undefined)
  );
}

/** Check before execution and before approval creation, using only trusted tool metadata. */
export function assertToolRunType(
  options: Pick<AssistantRunTypeOptions, 'workflowTools'>,
  tool: { slug: string; annotations?: { runTypes?: readonly string[] } },
): void {
  const runTypes = toolRunTypes(options, tool);
  if (runTypes && !runTypes.includes('turn'))
    throw new ToolRunTypeRefusal(tool.slug, runTypes);
}

/** Whether a refusal may be handed to a workflow run. */
export function mayEscalateToWorkflow(
  options: Pick<
    AssistantRunTypeOptions,
    'assistantSettings' | 'onWorkflowEscalation'
  >,
): boolean {
  return (
    options.assistantSettings?.escalateToWorkflow !== false &&
    typeof options.onWorkflowEscalation === 'function'
  );
}

/** The turn's execution from its accounting, when a selection is known. */
export function turnExecution(
  options: Pick<AssistantRunTypeOptions, 'selection'>,
  accounting: TurnAccounting | undefined,
  observed?: Partial<EngineExecution>,
): EngineExecution | undefined {
  const selection = options.selection;
  if (!selection || !accounting) return undefined;
  const model = accounting.model ?? observed?.model;
  return {
    engine: selection.engine,
    ...(model ? { model } : {}),
    ...((observed?.requestedModel ?? selection.model)
      ? { requestedModel: observed?.requestedModel ?? selection.model }
      : {}),
    ...(selection.effort ? { effort: selection.effort } : {}),
    durationMs: Date.now() - accounting.startedAt,
    ...(accounting.usageKnown ? { tokens: accounting.tokens } : {}),
    toolCalls: accounting.toolCalls,
    ...(observed?.fallback ? { fallback: observed.fallback } : {}),
  };
}

/** Report an execution; a host callback never breaks a turn. */
export function reportExecution(
  options: Pick<AssistantRunTypeOptions, 'onExecution'>,
  execution: EngineExecution | undefined,
): void {
  if (!execution || !options.onExecution) return;
  try {
    options.onExecution(execution);
  } catch {
    /* Accounting never breaks a turn. */
  }
}
