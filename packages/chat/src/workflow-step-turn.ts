/** Tool-free internal turns for hosts without chat rooms or HTTP requests. */
import {
  AiRunClaimLostError,
  aiRunStoppedError,
  getAiRun,
  withAiRunTransaction,
} from '@happyvertical/smrt-core';
import {
  type AssistantTurnOptions,
  runAssistantTurn,
} from './assistant-turn.js';
import type { AssistantTurnTracking } from './turn-tracking.js';

/** Server-selected engine and registered prompt for one workflow child turn. */
export interface WorkflowStepTurnOptions
  extends Pick<
    AssistantTurnOptions,
    'ai' | 'turnDriver' | 'principal' | 'selection' | 'signal' | 'maxTokens'
  > {
  tracking: AssistantTurnTracking & {
    parent: NonNullable<AssistantTurnTracking['parent']>;
  };
}

/**
 * Run a private, tool-free child turn using the same runner as `internalTurn`.
 * The host binds its engine (and denies tools at an external engine's MCP
 * boundary). No messages, sessions, tools or approvals are created. Calls and
 * reported usage belong to the child; the parent's handoff, fence and budgets
 * remain authoritative. Returns JSON text for the workflow's own validator.
 */
export async function runWorkflowStepTurn(
  options: WorkflowStepTurnOptions,
): Promise<string> {
  const parentContext = options.tracking.parent.context;
  const assertClaim = () =>
    withAiRunTransaction(parentContext.db, async (tx) => {
      try {
        if ((await parentContext.fence?.(tx.db, parentContext.runId)) === false)
          throw new AiRunClaimLostError(parentContext.runId);
      } catch (error) {
        if (error instanceof Error && error.name === 'JobClaimLostError')
          throw new AiRunClaimLostError(parentContext.runId, error);
        throw error;
      }
    });
  await assertClaim();
  let failure: unknown;
  const turn = runAssistantTurn({
    ...options,
    principal: { ...options.principal, allowedTools: [] },
    db: options.tracking.tracked.db,
    systemPrompt: options.tracking.prompt.text,
    userMessage: 'Return only the requested JSON.',
    tools: [],
    extraTools: [],
    clientTools: [],
    maxSteps: 1,
    toolChoice: 'none',
    onError: (error) => {
      failure = error;
    },
  });
  let result: Awaited<ReturnType<typeof turn.next>>;
  do {
    result = await turn.next();
  } while (!result.done);
  await assertClaim();
  const parent = await getAiRun(
    options.tracking.tracked.db,
    options.tracking.parent.context.runId,
  );
  if (parent && parent.status !== 'running') throw aiRunStoppedError(parent);
  if (failure) throw failure;
  options.signal?.throwIfAborted();
  if (!['stop', 'no_tools'].includes(result.value.stoppedReason))
    throw new Error('The workflow planning turn did not finish.');
  return result.value.content;
}
