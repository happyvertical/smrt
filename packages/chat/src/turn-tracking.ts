/**
 * The assistant turn as an AI run (#5005; docs/content/ai-runs.md section 3).
 *
 * A turn opens one `turn` run on the tenant's database before its first model
 * call, through core's tracked client. Every model call of the tool loop is a
 * tracked call of that run (one usage row and one `call` event each); tool use
 * is an `action` event and its result an `observation` event. Chat messages
 * are never copied into the trajectory: an event points at the message with
 * `payload_ref` (`chat-message:<id>`).
 *
 * A turn that needs an owner's approval records a requested `approval` event
 * and ends `done` with the approval pending: it does not wait. The decision is
 * recorded as an `approval` event in the NEXT turn's run, with
 * `parent_event_id` the request in the earlier run.
 *
 * The system prompt is the registered prompt {@link CHAT_ASSISTANT_PROMPT_KEY}:
 * a host's `systemPrompt` is its runtime layer, and an app or tenant override
 * of the key replaces both.
 */

import { randomUUID } from 'node:crypto';
import type { AIClient } from '@happyvertical/ai';
import {
  type AiRunBudget,
  type AiRunContext,
  aiRunStoppedError,
  appendAiRunEvent,
  closeAiRunHandoff,
  DEFAULT_INFERENCE_TIER,
  finishAiRun,
  getAiRun,
  type InferenceTier,
  stopAiRun,
  stopAiRunForChild,
  type TrackedAiClient,
  type TrackedAiClientOptions,
  type TrackedPromptCall,
} from '@happyvertical/smrt-core';
import {
  definePrompt,
  type ResolvedPrompt,
  type ResolvePromptOptions,
  resolvePrompt,
  trackedPromptCall,
} from '@happyvertical/smrt-prompts';
import type { AssistantApprovalRequest } from './assistant-turn-events.js';

/** The registered key of the chat assistant's system prompt. */
export const CHAT_ASSISTANT_PROMPT_KEY = 'chat.assistant.system';

/** The run definition key of a chat assistant turn. */
export const CHAT_TURN_DEFINITION_KEY = 'chat.assistant.turn';

/**
 * The chat assistant's system prompt. The text is applied only when a layer
 * above the default supplies it (a host's `systemPrompt`, an app or tenant
 * override); a host with none sends no system message, as before. The prompt
 * declares the tier the assistant asks for (`best`); a host binds the turn's
 * model with {@link resolveChatAssistantTier}.
 */
export const chatAssistantSystemPrompt = definePrompt({
  key: CHAT_ASSISTANT_PROMPT_KEY,
  template:
    'You are the assistant of this app. Use only the tools you are offered, and say plainly when you cannot do something.',
  ai: { profile: 'best' },
  editable: { template: true, profile: false, model: false, params: false },
});

/** What a turn needs to be tracked: set by the route that runs it. */
export interface AssistantTurnTracking {
  /** The tracked client of this turn's tenant and database. */
  tracked: TrackedAiClient;
  /** The assistant prompt, resolved. */
  prompt: ResolvedPrompt;
  /**
   * The run's definition key. Default {@link CHAT_TURN_DEFINITION_KEY}; a
   * host that runs its own assistant (the app shell) names its own.
   */
  definitionKey?: string;
  /**
   * What an event's `payload_ref` calls the host's stored messages
   * (`<prefix>:<id>`). Default `chat-message`.
   */
  messageRefPrefix?: string;
  /** The turn's budget (#5005), stored on its `turn` run. */
  budget?: AiRunBudget;
  /**
   * A host's workflow step that runs as this turn (internal turns only, set
   * by the route from the host's `internalTurn`): the turn's run is a CHILD
   * of the workflow run, recorded there as a `handoff` event, its calls
   * carry the parent's claim fence and the step's registered prompt
   * (`prompt`), and they roll up into the parent's totals and budget. A stop
   * or a budget limit on the parent stops the child's next call; a cancel of
   * the parent cancels it.
   */
  parent?: {
    context: AiRunContext;
    stepIndex?: number | null;
    name?: string | null;
  };
  /** Recorded as the run's tags, for finding a thread's turns. */
  threadId?: string;
  agentSessionId?: string;
  /**
   * Approvals of this thread that were decided since the last turn, read from
   * the host's approval store. Each is recorded once, in this turn's run.
   */
  decisions?: () => Promise<
    Array<{ approvalId: string; status: 'approved' | 'refused' }>
  >;
}

/**
 * Resolve the chat assistant prompt for a request: the registered default,
 * config and stored layers on `db`, and the host's `systemPrompt` as the
 * runtime layer. A database without prompt storage resolves the layers that
 * need none.
 */
export async function resolveChatAssistantPrompt(options: {
  db?: ResolvePromptOptions['db'];
  tenantId: string | null;
  systemPrompt?: string;
}): Promise<ResolvedPrompt> {
  const override = options.systemPrompt?.trim()
    ? { template: options.systemPrompt }
    : undefined;
  try {
    return await resolvePrompt(CHAT_ASSISTANT_PROMPT_KEY, {
      ...(options.db ? { db: options.db } : {}),
      tenantId: options.tenantId,
      ...(override ? { override } : {}),
    });
  } catch (error) {
    if (!options.db) throw error;
    return resolvePrompt(CHAT_ASSISTANT_PROMPT_KEY, {
      tenantId: options.tenantId,
      ...(override ? { override } : {}),
    });
  }
}

/**
 * The tier the chat assistant prompt asks for, as this tenant resolves it
 * (the code default, config and stored layers): what a host binds the turn's
 * model at. A prompt that names no concrete tier asks for core's default.
 */
export async function resolveChatAssistantTier(options: {
  db?: ResolvePromptOptions['db'];
  tenantId: string | null;
}): Promise<InferenceTier> {
  const { ai } = await resolveChatAssistantPrompt(options);
  return ai.tier && ai.tier !== 'auto' ? ai.tier : DEFAULT_INFERENCE_TIER;
}

/** The system text the turn sends, or undefined when no layer supplies one. */
export function chatAssistantSystemText(
  prompt: ResolvedPrompt,
): string | undefined {
  return prompt.ai.usageTags.promptLayer === 'default'
    ? undefined
    : prompt.text;
}

/**
 * The turn's chat client as a tracked client's provider: core takes a client
 * object that has `embed`, which a chat-only client lacks.
 */
export function chatClientForTracking(
  ai: object,
): NonNullable<TrackedAiClientOptions['ai']> {
  if (typeof (ai as { embed?: unknown }).embed === 'function') {
    return ai as NonNullable<TrackedAiClientOptions['ai']>;
  }
  return new Proxy(ai, {
    get(target, property, receiver) {
      if (property === 'embed') {
        return () => {
          throw new Error('The assistant client does not embed.');
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as NonNullable<TrackedAiClientOptions['ai']>;
}

function messageRef(prefix: string, id: unknown): string | null {
  return typeof id === 'string' && id !== '' ? `${prefix}:${id}` : null;
}

function approvalRef(id: string): string {
  return `approval:${id}`;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/** One open `turn` run. */
export class AssistantTurnRun {
  private readonly actions = new Map<string, string>();
  private readonly requests = new Map<string, string>();
  private ended = false;

  private constructor(
    private readonly tracking: AssistantTurnTracking,
    readonly context: AiRunContext,
    readonly runId: string,
    /** The `handoff` event in the parent run, for a workflow step's turn. */
    readonly handoffEventId: string | null = null,
  ) {}

  /**
   * Open the run, then record the decisions made since the last turn.
   * Throws `AiRunTrackingDisabledError` while usage persistence is off: a
   * chat turn does not run untracked.
   */
  static async open(
    tracking: AssistantTurnTracking,
    input: { originMessageId?: string } = {},
  ): Promise<AssistantTurnRun> {
    const parent = tracking.parent;
    const handoffEventId = parent ? randomUUID() : null;
    const { run, context } = await tracking.tracked.openRun({
      ...(parent
        ? {
            parentRunId: parent.context.runId,
            handoff: {
              eventId: handoffEventId as string,
              name: parent.name ?? null,
              stepIndex: parent.stepIndex ?? parent.context.stepIndex ?? null,
            },
          }
        : {}),
      type: 'turn',
      definitionKey: tracking.definitionKey ?? CHAT_TURN_DEFINITION_KEY,
      promptKey: tracking.prompt.key,
      templateHash: tracking.prompt.ai.usageTags.templateHash,
      tags: {
        ...(tracking.threadId ? { threadId: tracking.threadId } : {}),
        ...(tracking.agentSessionId
          ? { agentSessionId: tracking.agentSessionId }
          : {}),
      },
      ...(tracking.budget ? { budget: tracking.budget } : {}),
    });
    const turn = new AssistantTurnRun(
      tracking,
      parent?.context.fence
        ? { ...context, fence: parent.context.fence }
        : context,
      run.id,
      handoffEventId,
    );
    const ref = messageRef(turn.refPrefix, input.originMessageId);
    if (ref) {
      await turn.append({
        type: 'observation',
        name: 'user_message',
        status: 'ok',
        payloadRef: ref,
      });
    }
    await turn.recordDecisions();
    return turn;
  }

  private get refPrefix(): string {
    return this.tracking.messageRefPrefix ?? 'chat-message';
  }

  /** The prompt's tracked client for this turn's calls. */
  client(): Promise<AIClient> {
    return this.tracking.tracked.client(
      trackedPromptCall(this.tracking.prompt),
      { runContext: this.context },
    );
  }

  /** The tracked prompt of the turn's calls. */
  promptCall(): TrackedPromptCall {
    return trackedPromptCall(this.tracking.prompt);
  }

  private async append(
    event: Parameters<typeof appendAiRunEvent>[2],
  ): Promise<string | null> {
    try {
      const { id } = await appendAiRunEvent(
        this.tracking.tracked.db,
        this.runId,
        event,
      );
      return id;
    } catch {
      // The trajectory is a record of the turn, never a reason to fail it.
      return null;
    }
  }

  /** Record this turn's tool use from the tool loop's step events. */
  async step(event: {
    type: string;
    slug?: string;
    callId?: string;
    location?: string;
    ok?: boolean;
    error?: string;
  }): Promise<void> {
    if (this.ended) return;
    if (event.type === 'tool_call' && event.callId) {
      const id = await this.append({
        type: 'action',
        name: event.slug ?? null,
        status: 'ok',
        payload: { callId: event.callId, location: event.location ?? null },
      });
      if (id) this.actions.set(event.callId, id);
    } else if (event.type === 'tool_result' && event.callId) {
      await this.append({
        type: 'observation',
        name: event.slug ?? null,
        status: event.ok ? 'ok' : 'error',
        parentEventId: this.actions.get(event.callId) ?? null,
        payload: {
          callId: event.callId,
          ok: event.ok === true,
          ...(event.error ? { error: event.error } : {}),
        },
      });
    }
  }

  /** An owner approval was requested: the turn will end with it pending. */
  async approvalRequested(
    request: AssistantApprovalRequest,
    callId: string,
  ): Promise<void> {
    if (this.ended) return;
    const id = await this.append({
      type: 'approval',
      name: request.tool,
      status: 'requested',
      parentEventId: this.actions.get(callId) ?? null,
      payloadRef: approvalRef(request.id),
    });
    if (id) this.requests.set(request.id, id);
  }

  /**
   * An approval requested in this same turn was decided while the turn
   * waited on it (a host that holds the turn in process): the decision is an
   * event of this run, pointing at its request.
   */
  async approvalDecided(
    approvalId: string,
    status: 'approved' | 'refused',
  ): Promise<void> {
    const request = this.requests.get(approvalId);
    if (!request || this.ended) return;
    await this.append({
      type: 'approval',
      status,
      parentEventId: request,
      payloadRef: approvalRef(approvalId),
    });
  }

  /** The reply the turn stored, referenced and never copied. */
  async replied(messageId: unknown): Promise<void> {
    const ref = messageRef(this.refPrefix, messageId);
    if (!ref || this.ended) return;
    await this.append({
      type: 'observation',
      name: 'assistant_reply',
      status: 'ok',
      payloadRef: ref,
    });
  }

  /**
   * Decisions made since the last turn, each recorded once with its request
   * as `parent_event_id`. A request that was never recorded (a pruned or
   * foreign approval) is left alone.
   */
  private async recordDecisions(): Promise<void> {
    if (!this.tracking.decisions) return;
    let decided: Awaited<
      ReturnType<NonNullable<typeof this.tracking.decisions>>
    >;
    try {
      decided = await this.tracking.decisions();
    } catch {
      return;
    }
    const { db, tenantId } = this.tracking.tracked;
    for (const decision of decided) {
      try {
        const [request] = rowsOf(
          await db.query(
            `SELECT e.id AS id, e.name AS name FROM _smrt_ai_run_events e
               JOIN _smrt_ai_runs r ON r.id = e.run_id
              WHERE e.type = 'approval' AND e.status = 'requested'
                AND e.payload_ref = $1 AND r.tenant_id ${
                  tenantId === null ? 'IS NULL' : '= $2'
                }`,
            ...[
              approvalRef(decision.approvalId),
              ...(tenantId === null ? [] : [tenantId]),
            ],
          ),
        );
        if (!request) continue;
        const [done] = rowsOf(
          await db.query(
            `SELECT id FROM _smrt_ai_run_events
              WHERE type = 'approval' AND parent_event_id = $1`,
            String(request.id),
          ),
        );
        if (done) continue;
        await this.append({
          type: 'approval',
          name: typeof request.name === 'string' ? request.name : null,
          status: decision.status,
          parentEventId: String(request.id),
          payloadRef: approvalRef(decision.approvalId),
        });
      } catch {
        // Leave it for the next turn.
      }
    }
  }

  /**
   * End the run. A turn that ends for any reason but a cancellation or a
   * failure is `done`, an approval still pending included.
   */
  async finish(
    outcome: 'done' | 'cancelled' | 'failed',
    options: { degraded?: boolean } = {},
  ): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const { db } = this.tracking.tracked;
    try {
      if (outcome === 'cancelled') {
        await stopAiRun(db, this.runId, { reason: 'interrupted' });
      } else if (outcome === 'failed') {
        await finishAiRun(db, this.runId, {
          status: 'failed',
          stopReason: 'error',
        });
      } else {
        await finishAiRun(db, this.runId, {
          status: 'done',
          ...(options.degraded ? { degraded: true } : {}),
        });
      }
    } catch {
      // A run that a limit or a cancel already ended stays as it ended.
    }
    await this.closeHandoff();
  }

  /** End the parent's `handoff` with how this child run actually ended. */
  private async closeHandoff(): Promise<void> {
    const parent = this.tracking.parent;
    if (!parent || !this.handoffEventId) return;
    try {
      const run = await getAiRun(this.tracking.tracked.db, this.runId);
      const status =
        run?.status === 'done'
          ? 'done'
          : run?.status === 'cancelled'
            ? 'cancelled'
            : run?.status === 'failed'
              ? 'failed'
              : 'stopped';
      await closeAiRunHandoff(
        parent.context.db,
        parent.context.runId,
        this.handoffEventId,
        status,
      );
      // A child's stop reaches its parent as a stop (page section 6.2): a
      // limit of the workflow run, or its stop, leaves it stopped and
      // resumable, never a failed step.
      if (run && (run.status === 'stopped' || run.status === 'cancelled')) {
        await stopAiRunForChild(
          parent.context.db,
          parent.context.runId,
          aiRunStoppedError(run),
        );
      }
    } catch {
      // The parent's own record of the step is its check; never fail on it.
    }
  }
}
