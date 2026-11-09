// One assistant turn: the bounded tool-calling loop.
//
//   owner text -> model -> tool calls -> (policy) -> results -> model -> ...
//
// Rules, each tested:
//  - The model is offered exactly `toolsFor(principal)` minus a short deny
//    list (`approval_decide`: the assistant must never decide its own
//    approvals). A call to anything not offered is refused before dispatch,
//    and `callTool` authorizes again (the one policy, shared with /mcp).
//  - Calls run one at a time, in order. A risky call becomes an Approval and
//    the turn is HELD (`holdForUser`) until the owner decides; the model sees
//    only the outcome. Nothing here can set the engine's `approved` flag.
//  - Bounded: max steps, max tokens, per-call and per-turn timeouts, a cap on
//    calls per step and on result size. Client disconnect aborts everything.
import type { AIMessage, AITool, AIToolCall } from '@happyvertical/ai';
import type { TurnEvent, TurnStop } from '../../assistant/events.ts';
import type { AssistantThread } from '../../models/AssistantThread.ts';
import type { CatalogResponse, CatalogTool } from '../catalog.ts';
import { PolicyError, type Principal } from '../owner.ts';
import { callTool, toolsFor } from '../policy.ts';
import { systemPrompt } from './guidance.ts';
import { type HoldOutcome, holdForUser } from './hold.ts';
import type { AssistantModel, ModelToolCall } from './model.ts';
import { appendMessage, historyFor } from './threads.ts';

export interface TurnLimits {
  /** Model rounds per turn. */
  maxSteps: number;
  /** Output tokens asked of each model call. */
  maxTokensPerCall: number;
  /** Tokens the whole turn may use (as the provider reports them). */
  maxTotalTokens: number;
  /** Calls honored from one model reply; the rest are refused. */
  maxToolCallsPerStep: number;
  /** One model call. */
  modelTimeoutMs: number;
  /** Model and tool time of the whole turn (waiting for the owner excluded). */
  turnTimeoutMs: number;
  /** How long a turn waits on one approval. */
  holdTimeoutMs: number;
  /** A tool result is cut to this many characters before the model sees it. */
  toolResultChars: number;
}

export const DEFAULT_LIMITS: TurnLimits = {
  maxSteps: 8,
  maxTokensPerCall: 2048,
  maxTotalTokens: 60_000,
  maxToolCallsPerStep: 4,
  modelTimeoutMs: 60_000,
  turnTimeoutMs: 180_000,
  holdTimeoutMs: 15 * 60_000,
  toolResultChars: 12_000,
};

/** Tools the assistant never gets, even though the owner's `/mcp` has them. */
export const ASSISTANT_DENIED_TOOLS: ReadonlySet<string> = new Set([
  'approval_decide',
]);

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The tools offered to the model: the owner's allow-list minus the deny list. */
export async function assistantTools(
  principal: Principal,
): Promise<CatalogTool[]> {
  return (await toolsFor(principal)).filter(
    (t) => TOOL_NAME.test(t.name) && !ASSISTANT_DENIED_TOOLS.has(t.name),
  );
}

function toAiTool(tool: CatalogTool): AITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? {
        type: 'object',
        properties: {},
      },
    },
  };
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} [cut]` : text;
}

function textOf(response: CatalogResponse): string {
  const c = response.content;
  if (Array.isArray(c)) {
    const parts = c
      .map((p) =>
        p &&
        typeof p === 'object' &&
        typeof (p as { text?: unknown }).text === 'string'
          ? (p as { text: string }).text
          : JSON.stringify(p),
      )
      .join('\n');
    if (parts) return parts;
  }
  if (typeof c === 'string') return c;
  return JSON.stringify(response.structuredContent ?? c ?? null);
}

interface Pending {
  approvalId: string;
  summary: string;
  preview: unknown;
}

function pendingOf(response: CatalogResponse): Pending | null {
  const candidates: unknown[] = [response.structuredContent];
  try {
    candidates.push(JSON.parse(textOf(response)));
  } catch {
    // not JSON
  }
  for (const raw of candidates) {
    // Generated shell tools may wrap a method's return as `{ result }`.
    const c =
      raw && typeof raw === 'object' && 'result' in raw
        ? (raw as { result: unknown }).result
        : raw;
    const p = c as { status?: unknown; approvalId?: unknown } | null;
    if (
      p &&
      typeof p === 'object' &&
      p.status === 'pending_approval' &&
      typeof p.approvalId === 'string'
    ) {
      const full = p as unknown as Pending;
      return {
        approvalId: full.approvalId,
        summary: String(full.summary ?? ''),
        preview: full.preview ?? null,
      };
    }
  }
  return null;
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface RunTurnOptions {
  principal: Principal;
  thread: AssistantThread;
  text: string;
  model: AssistantModel;
  signal: AbortSignal;
  emit(event: TurnEvent): void;
  limits?: Partial<TurnLimits>;
  /** Tests substitute the hold; production waits on the approval bus. */
  hold?: typeof holdForUser;
}

interface CallOutcome {
  /** What the model is told. */
  content: string;
  ok: boolean;
  summary: string;
  approvalId?: string;
  /** Stop the turn after this call (an approval left undecided / aborted). */
  stop?: TurnStop;
}

/** Run one turn to its end. Never throws for model, tool or abort failures. */
export async function runTurn(options: RunTurnOptions): Promise<TurnStop> {
  const { principal, thread, emit, signal } = options;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const hold = options.hold ?? holdForUser;
  let activeMs = 0;
  let tokens = 0;

  await appendMessage(thread, { role: 'user', content: options.text });
  const history: AIMessage[] = await historyFor(thread.id as string);

  const finish = (stop: TurnStop): TurnStop => {
    emit({ type: 'done', stop });
    return stop;
  };

  const execute = async (
    call: ModelToolCall,
    offered: Map<string, CatalogTool>,
  ): Promise<CallOutcome> => {
    emit({
      type: 'tool_call',
      id: call.id,
      name: call.name,
      args: cut(call.arguments, 400),
    });
    let args: Record<string, unknown>;
    try {
      const parsed = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not an object');
      args = parsed as Record<string, unknown>;
    } catch {
      return refuse('The arguments were not a JSON object. Nothing was run.');
    }
    // Offer gate: only what was offered, re-checked against a fresh listing
    // (the catalog changes with the app) and the deny list.
    if (
      !offered.has(call.name) ||
      ASSISTANT_DENIED_TOOLS.has(call.name) ||
      !(await assistantTools(principal)).some((t) => t.name === call.name)
    )
      return refuse(`There is no tool named ${call.name}. Nothing was run.`);
    let response: CatalogResponse;
    const started = Date.now();
    try {
      // Execution gate: callTool authorizes again (owner, catalog).
      response = await callTool(principal, call.name, args);
    } catch (error) {
      activeMs += Date.now() - started;
      if (error instanceof PolicyError) return refuse(error.message);
      const message =
        error instanceof Error ? oneLine(error.message, 300) : 'it failed';
      return {
        ok: false,
        summary: message,
        content: JSON.stringify({ error: message }),
      };
    }
    activeMs += Date.now() - started;
    const pending = pendingOf(response);
    if (!pending) {
      const text = cut(textOf(response), limits.toolResultChars);
      const ok = response.isError !== true;
      return { ok, summary: oneLine(text), content: text };
    }
    emit({
      type: 'approval_required',
      id: call.id,
      name: call.name,
      approvalId: pending.approvalId,
      summary: pending.summary,
      preview: pending.preview,
    });
    const outcome: HoldOutcome = await hold(pending.approvalId, {
      signal,
      timeoutMs: limits.holdTimeoutMs,
    });
    return decided(call, pending, outcome);
  };

  const refuse = (message: string): CallOutcome => ({
    ok: false,
    summary: message,
    content: JSON.stringify({ error: message }),
  });

  const decided = (
    call: ModelToolCall,
    pending: Pending,
    outcome: HoldOutcome,
  ): CallOutcome => {
    const base = { approvalId: pending.approvalId };
    if (outcome.status === 'approved') {
      emit({
        type: 'approval_decided',
        id: call.id,
        approvalId: pending.approvalId,
        status: 'approved',
      });
      const text = cut(
        JSON.stringify({
          status: 'approved',
          note: 'The owner approved this and it was applied.',
          result: outcome.result,
        }),
        limits.toolResultChars,
      );
      return {
        ...base,
        ok: true,
        summary: 'Approved and applied',
        content: text,
      };
    }
    if (outcome.status === 'denied') {
      emit({
        type: 'approval_decided',
        id: call.id,
        approvalId: pending.approvalId,
        status: 'denied',
      });
      return {
        ...base,
        ok: false,
        summary: 'Denied by you',
        content: JSON.stringify({
          status: 'denied',
          note: 'The owner denied this. It was NOT applied. Do not retry it unless they ask again.',
        }),
      };
    }
    if (outcome.status === 'failed') {
      emit({
        type: 'approval_decided',
        id: call.id,
        approvalId: pending.approvalId,
        status: 'failed',
      });
      return {
        ...base,
        ok: false,
        summary: 'Approved, but it failed',
        content: JSON.stringify({
          status: 'failed',
          error: oneLine(outcome.error, 300),
        }),
      };
    }
    if (outcome.status === 'timeout')
      emit({
        type: 'approval_decided',
        id: call.id,
        approvalId: pending.approvalId,
        status: 'timeout',
      });
    return {
      ...base,
      ok: false,
      summary: 'Waiting for your decision',
      stop: outcome.status === 'aborted' ? 'aborted' : 'waiting',
      content: JSON.stringify({
        status: 'waiting',
        approvalId: pending.approvalId,
        note: 'Waiting for the owner to decide. Nothing was applied. The turn ended before an answer.',
      }),
    };
  };

  for (let step = 1; ; step++) {
    if (signal.aborted) return finish('aborted');
    if (step > limits.maxSteps) {
      const note =
        'I stopped here to keep things short. Tell me if you want me to continue.';
      emit({ type: 'text', delta: note });
      await appendMessage(thread, { role: 'assistant', content: note });
      return finish('max_steps');
    }
    if (tokens >= limits.maxTotalTokens) return finish('max_tokens');
    if (activeMs >= limits.turnTimeoutMs) {
      emit({
        type: 'error',
        code: 'timeout',
        message: 'The assistant took too long.',
      });
      return finish('timeout');
    }

    const tools = await assistantTools(principal);
    const offered = new Map(tools.map((t) => [t.name, t]));

    let streamed = false;
    const callSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(
        Math.min(limits.modelTimeoutMs, limits.turnTimeoutMs - activeMs),
      ),
    ]);
    const started = Date.now();
    let reply: Awaited<ReturnType<AssistantModel['complete']>>;
    try {
      reply = await options.model.complete({
        messages: [{ role: 'system', content: systemPrompt() }, ...history],
        tools: tools.map(toAiTool),
        maxTokens: limits.maxTokensPerCall,
        signal: callSignal,
        onText: (delta) => {
          if (!delta) return;
          streamed = true;
          emit({ type: 'text', delta });
        },
      });
    } catch (error) {
      activeMs += Date.now() - started;
      if (signal.aborted) return finish('aborted');
      if (callSignal.aborted) {
        emit({
          type: 'error',
          code: 'timeout',
          message: 'The assistant took too long.',
        });
        return finish('timeout');
      }
      const name =
        error instanceof Error
          ? `${error.name}${(error as { code?: unknown }).code ? `/${String((error as { code?: unknown }).code)}` : ''}`
          : 'unknown';
      // biome-ignore lint/suspicious/noConsole: class and code only, never a message
      console.error('assistant model call failed:', name);
      emit({
        type: 'error',
        code: 'model_error',
        message: 'The assistant could not reach its model. Try again.',
      });
      return finish('error');
    }
    activeMs += Date.now() - started;
    tokens += reply.totalTokens ?? 0;
    if (!streamed && reply.text) emit({ type: 'text', delta: reply.text });

    const kept = reply.toolCalls.slice(0, limits.maxToolCallsPerStep);
    const keptCalls: AIToolCall[] = kept.map(
      (c) =>
        reply.raw?.find((r) => r.id === c.id) ?? {
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        },
    );
    await appendMessage(thread, {
      role: 'assistant',
      content: reply.text,
      ...(keptCalls.length ? { toolCalls: keptCalls } : {}),
    });
    history.push({
      role: 'assistant',
      content: reply.text,
      ...(keptCalls.length ? { tool_calls: keptCalls } : {}),
    });
    if (kept.length === 0) return finish('complete');

    let stop: TurnStop | undefined;
    for (const call of kept) {
      let outcome: CallOutcome;
      if (stop) {
        outcome = refuse('Not run: the turn ended first.');
      } else if (signal.aborted) {
        stop = 'aborted';
        outcome = refuse('Not run: the turn was stopped.');
      } else {
        outcome = await execute(call, offered);
        stop = outcome.stop;
      }
      emit({
        type: 'tool_result',
        id: call.id,
        name: call.name,
        ok: outcome.ok,
        summary: outcome.summary,
      });
      const meta = {
        id: call.id,
        name: call.name,
        ok: outcome.ok,
        summary: outcome.summary,
        ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}),
      };
      await appendMessage(thread, {
        role: 'tool',
        content: outcome.content,
        toolCallId: call.id,
        meta,
      });
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: outcome.content,
      });
    }
    if (stop === 'waiting') {
      const note =
        'I am waiting for your decision on the change above. Nothing has been applied yet.';
      emit({ type: 'text', delta: note });
      await appendMessage(thread, { role: 'assistant', content: note });
      return finish('waiting');
    }
    if (stop) return finish(stop);
  }
}
