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
  type AiRunCallHandle,
  type AiRunContext,
  type AiRunObservedUsage,
  aiRunStoppedError,
  appendAiRunEvent,
  beginAiRunCall,
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
import type { AssistantModelSelection } from './tool-run-types.js';

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

/**
 * The open turn run an external engine's turn is recorded in (internal: set
 * by `runAssistantTurn`, read by the external-driver bridge).
 */
export const TURN_RUN = Symbol('turnRun');

/**
 * What an engine reported about its turn, as a tracked call's usage: the
 * model it ran (else the one it was bound to) and its tokens when it reported
 * them. Without a token count the call has no usage: settled as answered it
 * is charged what it reserved (ai-runs section 6.4), released otherwise.
 */
export interface AssistantEngineReport {
  model?: string;
  requestedModel?: string;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

function engineUsage(
  report: AssistantEngineReport | undefined,
  fallbackModel: string | undefined,
): AiRunObservedUsage {
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  const total = count(report?.tokens);
  const input = count(report?.inputTokens);
  const output = count(report?.outputTokens);
  const model = report?.model ?? report?.requestedModel ?? fallbackModel;
  return {
    ...(model ? { model } : {}),
    ...(total !== undefined
      ? {
          usage: {
            // The split only where the engine reported it.
            ...(input !== undefined && output !== undefined
              ? { promptTokens: input, completionTokens: output }
              : {}),
            totalTokens: total,
          } as AiRunObservedUsage['usage'],
        }
      : {}),
    ...(count(report?.durationMs) !== undefined
      ? { duration: report?.durationMs }
      : {}),
  };
}

/**
 * One engine turn as one tracked call of the turn's run, between its
 * reservation and its end. End it exactly once.
 */
export interface AssistantEngineCall {
  /** Aborted at the chain's `callTimeoutMs`. */
  readonly signal: AbortSignal | undefined;
  /** Whether the call timed out at `callTimeoutMs`. */
  readonly timedOut: boolean;
  /**
   * The engine turn answered: settle it with what it reported (its tokens,
   * else charged its reservation).
   */
  answered(report?: AssistantEngineReport): Promise<void>;
  /**
   * The engine turn ended without an answer (failed, cancelled, timed out,
   * handed off): settled with its tokens when it reported them, else
   * released. Returns the error to raise.
   */
  ended(error: unknown, report?: AssistantEngineReport): Promise<unknown>;
}

function messageRef(prefix: string, id: unknown): string | null {
  return typeof id === 'string' && id !== '' ? `${prefix}:${id}` : null;
}

/** Decisions looked up per query, well under any engine's bound-parameter cap. */
const DECISION_LOOKUP_CHUNK = 200;

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

  /**
   * The prompt's tracked client for this turn's calls. With the host's
   * selection, its calls also carry the tier asked for and bound.
   */
  client(selection?: AssistantModelSelection): Promise<AIClient> {
    return this.tracking.tracked.client(
      trackedPromptCall(this.tracking.prompt, {
        usageTags: this.tierTags(selection),
      }),
      { runContext: this.context },
    );
  }

  /**
   * The tracked prompt of the turn's calls, the one {@link client} carries.
   * An engine call made outside the client (Claude Code, Codex) records
   * under it.
   */
  promptCall(selection?: AssistantModelSelection): TrackedPromptCall {
    return trackedPromptCall(this.tracking.prompt, {
      usageTags: this.tierTags(selection),
    });
  }

  /** The tier the prompt asks for and the tier the host bound the turn at. */
  private tierTags(
    selection: AssistantModelSelection | undefined,
  ): Record<string, string> {
    const asked = this.tracking.prompt.ai.tier;
    const requested = asked && asked !== 'auto' ? asked : selection?.tier;
    return {
      ...(requested ? { tierRequested: String(requested) } : {}),
      ...(selection?.tier ? { tierResolved: String(selection.tier) } : {}),
    };
  }

  /**
   * Reserve one external engine turn (a Claude Code or Codex session) as one
   * call of this run, before the engine starts (ai-runs section 6.4): the
   * call id is minted first, the run's and its ancestors' limits apply, and a
   * refused reservation stops the run and throws `AiRunStoppedError`. The
   * engine reports one result per turn, so its internal model calls are
   * recorded as this one call. The usage row names the engine as provider
   * and the model it reported (else the tier binding's), carries the prompt
   * key and the tiers, and is uncosted (an engine has no price).
   */
  async beginEngineCall(input: {
    selection?: AssistantModelSelection;
    /** The characters the engine is sent: system text, history, message. */
    inputChars: number;
    signal?: AbortSignal;
  }): Promise<AssistantEngineCall> {
    const { selection } = input;
    const prompt = this.promptCall(selection);
    const model = selection?.model;
    const fallback = {
      provider: selection?.engine ?? 'external',
      model: model ?? 'unknown',
      operation: 'chat',
      className: 'AssistantTurn',
      tenantId: this.tracking.tracked.tenantId,
      tags: {
        ...(prompt.usageTags ?? {}),
        promptKey: prompt.promptKey,
        ...(prompt.templateHash ? { templateHash: prompt.templateHash } : {}),
      },
    };
    const handle: AiRunCallHandle = await beginAiRunCall(this.context, {
      inputChars: input.inputChars,
      rate: null,
      fallbackUsage: fallback,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const callTimeout = handle.invocation.signal;
    let timedOut = false;
    if (handle.reservation.callTimeoutMs !== null && callTimeout) {
      callTimeout.addEventListener(
        'abort',
        () => {
          if (!input.signal?.aborted) timedOut = true;
        },
        { once: true },
      );
    }
    return {
      signal: callTimeout,
      get timedOut() {
        return timedOut;
      },
      answered: (report) => handle.succeed(engineUsage(report, model)),
      ended: (error, report) => {
        const observed = engineUsage(report, model);
        if (observed.usage) {
          handle.invocation.capture({
            ...fallback,
            model: observed.model ?? fallback.model,
            usage: observed.usage,
            duration: observed.duration ?? 0,
            timestamp: new Date(),
          });
        }
        return handle.fail(error);
      },
    };
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
   * foreign approval) is left alone. One query per
   * {@link DECISION_LOOKUP_CHUNK} decisions finds the approvals whose
   * decision is not recorded yet, however many the thread ever asked for.
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
    for (let at = 0; at < decided.length; at += DECISION_LOOKUP_CHUNK) {
      const chunk = decided.slice(at, at + DECISION_LOOKUP_CHUNK);
      const byRef = new Map(
        chunk.map((decision) => [approvalRef(decision.approvalId), decision]),
      );
      const refs = [...byRef.keys()];
      const marks = refs.map((_, i) => `$${i + 1}`).join(', ');
      const tenant = tenantId === null ? 'IS NULL' : `= $${refs.length + 1}`;
      let open: Array<Record<string, unknown>>;
      try {
        open = rowsOf(
          await db.query(
            `SELECT e.id AS id, e.name AS name, e.payload_ref AS payload_ref
               FROM _smrt_ai_run_events e
               JOIN _smrt_ai_runs r ON r.id = e.run_id
              WHERE e.type = 'approval' AND e.status = 'requested'
                AND e.payload_ref IN (${marks})
                AND r.tenant_id ${tenant}
                AND NOT EXISTS (
                  SELECT 1 FROM _smrt_ai_run_events d
                   WHERE d.type = 'approval' AND d.status <> 'requested'
                     AND d.payload_ref = e.payload_ref
                )
              ORDER BY e.created_at, e.id`,
            ...refs,
            ...(tenantId === null ? [] : [tenantId]),
          ),
        );
      } catch {
        // Leave them for the next turn.
        continue;
      }
      // Once per approval, in the order decided: its first request takes it.
      const firstOpen = new Map<string, Record<string, unknown>>();
      for (const request of open) {
        const ref = String(request.payload_ref);
        if (!firstOpen.has(ref)) firstOpen.set(ref, request);
      }
      for (const [ref, decision] of byRef) {
        const request = firstOpen.get(ref);
        if (!request) continue;
        await this.append({
          type: 'approval',
          name: typeof request.name === 'string' ? request.name : null,
          status: decision.status,
          parentEventId: String(request.id),
          payloadRef: approvalRef(decision.approvalId),
        });
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
