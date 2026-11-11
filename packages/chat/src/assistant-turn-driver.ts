/** Host-supplied assistant loops. This module never imports an inference engine. */
import type { AIMessage } from '@happyvertical/ai';
import type {
  PrincipalBinding,
  PrincipalTool,
} from '@happyvertical/smrt-agents';
import {
  ASSISTANT_TURN_GENERIC_ERROR,
  type AssistantTurnOptions,
  type AssistantTurnResult,
  type AssistantTurnState,
  AssistantTurnUserError,
} from './assistant-turn.js';
import type {
  AssistantApprovalRequest,
  AssistantTurnEvent,
} from './assistant-turn-events.js';
import { sendAgentReply } from './services/ChatService.js';
import {
  type ManifestTool,
  replyMetadataFor,
  resolveTurnReply,
  type ToolLoopUsage,
} from './tool-loop.js';

/** A decision from the host's owner-approval authority, never from model output. */
export interface AssistantApprovalDecision {
  approved: boolean;
  reason?: string;
}

/** The context a trusted external loop receives; messages are oldest first. */
export interface AssistantTurnDriverContext {
  thread?: { id: string; roomId?: string; agentSessionId: string };
  originMessageId?: string;
  history: readonly AIMessage[];
  userMessage: string;
  systemPrompt: string;
  principal: PrincipalBinding;
  /** When supplied, an execution/MCP adapter must preserve this permission ceiling. */
  permissions?: readonly string[];
  /** Only offered, allow-listed server tools. MCP execution must enforce this principal too. */
  tools: readonly ManifestTool[];
  extraTools: readonly PrincipalTool[];
  signal: AbortSignal;
}

/** C3 bridge: persist a request and wait for a durable owner decision. */
export type AssistantApprovalWaiter = (
  request: AssistantApprovalRequest,
  context: AssistantTurnDriverContext,
) => Promise<AssistantApprovalDecision>;

/** One external tool call. Names are canonical app tool slugs, not provider aliases. */
export interface AssistantDriverToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Engine callbacks; await tool callbacks so persistence finishes before continuing. */
export interface AssistantTurnDriverCallbacks {
  text(delta: string): void;
  toolCall(call: AssistantDriverToolCall): Promise<void>;
  toolResult(result: {
    id: string;
    ok: boolean;
    result?: string;
    error?: string;
  }): Promise<void>;
  approvalNeeded(
    request: AssistantApprovalRequest,
  ): Promise<AssistantApprovalDecision>;
  done(result: { text: string; usage?: ToolLoopUsage }): void;
  /** Detail is logged server-side; the wire and stored error are sanitized. */
  error(error: unknown): void;
}

/** A trusted, host-supplied loop. Call done/error once and settle run; honor signal. */
export interface AssistantTurnDriver {
  run(
    context: AssistantTurnDriverContext,
    callbacks: AssistantTurnDriverCallbacks,
  ): Promise<void>;
}

/** Chat-owned external-driver bridge; the default tool loop never enters here. */
export async function runExternalAssistantTurn<M>(
  options: AssistantTurnOptions<M>,
  emit: (event: AssistantTurnEvent<M>) => void,
  serialize: (message: unknown) => M,
  describe: (name: string, args?: Record<string, unknown>) => string,
  report: (state: AssistantTurnState['state']) => Promise<boolean>,
): Promise<AssistantTurnResult> {
  if (options.resume) {
    throw new AssistantTurnUserError(
      'External turns cannot resume browser tool calls.',
      'driver_resume_unsupported',
    );
  }
  const userMessage = options.userMessage?.trim();
  if (!userMessage)
    throw new AssistantTurnUserError(
      'No user message to respond to.',
      'empty_message',
    );
  const driver = options.turnDriver;
  if (!driver) throw new Error('An external turn needs a driver.');
  const signal = options.signal ?? new AbortController().signal;
  const allowed = new Set(options.principal.allowedTools ?? []);
  const context: AssistantTurnDriverContext = {
    thread: options.thread,
    originMessageId: options.originMessageId,
    history: options.history ?? [],
    userMessage,
    systemPrompt: options.systemPrompt ?? '',
    principal: options.principal,
    permissions: options.permissions,
    tools: (options.tools ?? []).filter((tool) => allowed.has(tool.slug)),
    extraTools: (options.extraTools ?? []).filter((tool) =>
      allowed.has(tool.slug),
    ),
    signal,
  };
  const offered = new Set(
    [...context.tools, ...context.extraTools].map((tool) => tool.slug),
  );
  const calls = new Map<string, AssistantDriverToolCall>();
  const completed = new Set<string>();
  let text = '';
  let final: { text: string; usage?: ToolLoopUsage } | undefined;
  let failure: unknown;
  let failed = false;
  let closed = false;
  let terminal = false;
  let pending = Promise.resolve();
  const active = () => !closed && !terminal && !signal.aborted;
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    if (!active()) return Promise.resolve();
    pending = pending.then(task);
    // Keep a fire-and-forget engine callback from causing an unhandled rejection.
    void pending.catch(() => {});
    return pending;
  };
  const persist = async (
    content: string,
    messageType: 'text' | 'tool_call' | 'tool_result',
    toolCallData?: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): Promise<M | undefined> => {
    const author = options.author;
    if (!author) return;
    const message = await sendAgentReply(author.chatService, {
      tenantId: author.tenantId,
      agentSessionId: author.agentSessionId,
      threadId: author.threadId ?? null,
      replyToMessageId: options.originMessageId ?? null,
      kind: messageType === 'text' ? 'assistant' : 'tool',
      content,
      messageType,
      toolCallData,
      metadata,
    });
    const wire = serialize(message);
    emit({ type: 'message', message: wire });
    return wire;
  };
  const callbacks: AssistantTurnDriverCallbacks = {
    text(delta) {
      if (!active() || !delta) return;
      text += delta;
      emit({ type: 'token', text: delta });
    },
    toolCall: (call) =>
      enqueue(async () => {
        if (!offered.has(call.name) || calls.has(call.id)) {
          throw new Error(
            'The external driver reported an unoffered or duplicate tool call.',
          );
        }
        calls.set(call.id, call);
        const label = describe(call.name, call.args);
        emit({
          type: 'step',
          step: {
            kind: 'tool_call',
            callId: call.id,
            tool: call.name,
            label,
            location: 'server',
          },
        });
        emit({
          type: 'status',
          status: { state: 'working', label: `${label}…`, cancellable: true },
        });
        await persist(label, 'tool_call', {
          id: call.id,
          name: call.name,
          args: call.args,
        });
      }),
    toolResult: (result) =>
      enqueue(async () => {
        const call = calls.get(result.id);
        if (!call || completed.has(result.id))
          throw new Error(
            'The external driver reported an unmatched tool result.',
          );
        completed.add(result.id);
        emit({
          type: 'step',
          step: {
            kind: 'tool_result',
            callId: call.id,
            tool: call.name,
            label: describe(call.name),
            ok: result.ok,
            ...(result.error ? { error: result.error } : {}),
          },
        });
        await persist(result.result ?? result.error ?? '', 'tool_result', {
          id: call.id,
          name: call.name,
          args: call.args,
          status: result.ok ? 'success' : 'error',
        });
      }),
    async approvalNeeded(request) {
      await pending;
      if (!active()) return { approved: false, reason: 'cancelled' };
      const call = calls.get(request.callId);
      if (!call || call.name !== request.tool || completed.has(call.id)) {
        throw new Error(
          'The external driver requested approval for an unmatched tool call.',
        );
      }
      emit({ type: 'approval_needed', approval: request });
      if (!options.waitForApproval)
        return { approved: false, reason: 'approval_unavailable' };
      // The same abort race that stops the driver also releases an approval wait.
      return Promise.race([
        options.waitForApproval(request, context),
        aborted.then(() => ({ approved: false, reason: 'cancelled' })),
      ]);
    },
    done(value) {
      if (!active()) return;
      final = value;
      terminal = true;
    },
    error(error) {
      if (!active()) return;
      failure = error;
      failed = true;
      terminal = true;
    },
  };
  let onAbort: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
  });
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    if (!signal.aborted) {
      await Promise.race([driver.run(context, callbacks), aborted]);
    }
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    closed = true;
    signal.removeEventListener('abort', onAbort);
    try {
      await pending;
    } catch (error) {
      failure = error;
      failed = true;
    }
  }
  if (signal.aborted) {
    if (text.trim())
      await persist(text, 'text', undefined, { stoppedReason: 'cancelled' });
    await report('cancelled');
    emit({ type: 'done', stoppedReason: 'cancelled' });
    emit({ type: 'status', status: { state: 'idle', label: 'Stopped' } });
    return {
      stoppedReason: 'cancelled',
      content: text,
      originMessageId: options.originMessageId,
    };
  }
  if (failed || !final) {
    if (text.trim())
      await persist(text, 'text', undefined, {
        stoppedReason: 'error',
        partial: true,
      });
    await persist(ASSISTANT_TURN_GENERIC_ERROR, 'text', undefined, {
      stoppedReason: 'error',
      fallback: 'provider_error',
    });
    throw failed
      ? failure
      : new Error('The external driver returned without done.');
  }
  const reply = resolveTurnReply(
    { content: final.text },
    options.emptyAnswerFallback,
  );
  const content = reply.content;
  const stoppedReason = reply.fallback ? 'empty' : 'stop';
  const message = await persist(
    content,
    'text',
    undefined,
    replyMetadataFor({ stoppedReason }, reply),
  );
  if (final.usage) {
    try {
      options.onUsage?.(final.usage);
    } catch {
      /* Usage accounting never breaks a turn. */
    }
  }
  await report('completed');
  emit({
    type: 'done',
    ...(message ? { message } : {}),
    stoppedReason,
  });
  emit({ type: 'status', status: { state: 'done', label: 'Done' } });
  return {
    stoppedReason,
    content,
    originMessageId: options.originMessageId,
  };
}
