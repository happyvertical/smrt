/** Host-supplied assistant loops. This module never imports an inference engine. */
import type { AIMessage } from '@happyvertical/ai';
import type {
  PrincipalBinding,
  PrincipalTool,
} from '@happyvertical/smrt-agents';
import type {
  ResolvedWorkProfile,
  WorkRunMetadata,
} from '@happyvertical/smrt-inference';
import { requiresOwnerApproval } from './assistant-approvals.js';
import {
  type AssistantTurnOptions,
  type AssistantTurnResult,
  type AssistantTurnState,
  AssistantTurnUserError,
  runAssistantTurn,
} from './assistant-turn.js';
import type {
  AssistantApprovalRequest,
  AssistantClientToolCall,
  AssistantClientToolResult,
  AssistantTurnEvent,
} from './assistant-turn-events.js';
import { sendAgentReply } from './services/ChatService.js';
import {
  isManifestToolEnabled,
  type ManifestTool,
  replyMetadataFor,
  resolveTurnReply,
  type ToolLoopUsage,
} from './tool-loop.js';
import type { DescribeAssistantTool } from './tool-summary.js';
import {
  assertWorkProfileTool,
  WORK_RUN_ACCOUNTING,
  WorkProfileEscalation,
} from './work-profile.js';

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
  workProfile?: ResolvedWorkProfile;
  /** MUST run at the authenticated MCP boundary before any side effect. */
  beforeToolExecution(tool: string): void;
  signal: AbortSignal;
  /** The same host-configured server-write policy used by the built-in loop. */
  requiresApproval(tool: string, args: Record<string, unknown>): boolean;
}

/** C3 bridge: persist a request and wait for a durable owner decision. */
export type AssistantApprovalWaiter = (
  request: AssistantApprovalRequest,
  context: AssistantTurnDriverContext,
) => Promise<AssistantApprovalDecision>;

/** One external tool call. Names are canonical app tool slugs, not provider aliases. */
export type AssistantDriverToolCall = Pick<
  AssistantClientToolCall,
  'id' | 'name' | 'args'
>;

/** Engine callbacks; await tool callbacks so persistence finishes before continuing. */
export interface AssistantTurnDriverCallbacks {
  text(delta: string): void;
  toolCall(call: AssistantDriverToolCall): Promise<void>;
  toolResult(result: AssistantClientToolResult): Promise<void>;
  approvalNeeded(
    request: AssistantApprovalRequest,
  ): Promise<AssistantApprovalDecision>;
  execution?(metadata: WorkRunMetadata): void;
  done(result: {
    text: string;
    usage?: ToolLoopUsage;
    workRun?: WorkRunMetadata;
  }): void;
  /** Detail is logged server-side; the wire and stored error are sanitized. */
  error(error: unknown): void;
}

/** A trusted, host-supplied loop. Call done/error once and settle run; honor signal. */
export interface AssistantTurnDriver {
  /** Trusted host-owned durable ledger observer; never decides or executes a hold. */
  waitForApproval?: AssistantApprovalWaiter;
  run(
    context: AssistantTurnDriverContext,
    callbacks: AssistantTurnDriverCallbacks,
  ): Promise<void>;
}

/** Chat-owned external-driver bridge; the default tool loop never enters here. */
async function runExternalAssistantAttempt<M>(
  options: AssistantTurnOptions<M>,
  emit: (event: AssistantTurnEvent<M>) => void,
  serialize: (message: unknown) => M,
  describe: DescribeAssistantTool,
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
  if (driver.waitForApproval && options.approvals)
    throw new Error(
      'A host-owned approval observer cannot be combined with another approval authority.',
    );
  const attempt = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, attempt.signal])
    : attempt.signal;
  let escalation: WorkProfileEscalation | undefined;
  const completedHistory: AIMessage[] = [];
  const accounting = options[WORK_RUN_ACCOUNTING] ?? {
    startedAt: Date.now(),
    tokens: 0,
    usageKnown: true,
    toolCalls: 0,
  };
  options = { ...options, [WORK_RUN_ACCOUNTING]: accounting };
  let observed: WorkRunMetadata | undefined;
  const startedAt = accounting.startedAt;
  const allowed = new Set(options.principal.allowedTools ?? []);
  const context: AssistantTurnDriverContext = {
    thread: options.thread,
    originMessageId: options.originMessageId,
    history: options.history ?? [],
    userMessage,
    systemPrompt: options.systemPrompt ?? '',
    principal: options.principal,
    permissions: options.permissions,
    tools: (options.tools ?? []).filter(
      (tool) =>
        allowed.has(tool.slug) &&
        isManifestToolEnabled(tool, options.principal.tenantId),
    ),
    extraTools: (options.extraTools ?? []).filter((tool) =>
      allowed.has(tool.slug),
    ),
    signal,
    workProfile: options.workProfile,
    beforeToolExecution(name) {
      const tool = [...context.tools, ...context.extraTools].find(
        (tool) => tool.slug === name,
      );
      if (!tool) throw new Error('The tool is not offered to this turn.');
      try {
        assertWorkProfileTool(options, tool);
      } catch (error) {
        if (error instanceof WorkProfileEscalation) {
          escalation = error;
          attempt.abort();
        }
        throw error;
      }
    },
    requiresApproval(name, args) {
      const tool = [
        ...(options.tools ?? []),
        ...(options.extraTools ?? []),
      ].find((tool) => tool.slug === name);
      return (
        !tool ||
        requiresOwnerApproval(
          tool,
          args,
          options.approvals?.policy ?? options.approvalPolicy,
        )
      );
    },
  };
  const offered = new Set(
    [...context.tools, ...context.extraTools].map((tool) => tool.slug),
  );
  const enabled = (name: string) => {
    const tool = context.tools.find((tool) => tool.slug === name);
    return !tool || isManifestToolEnabled(tool, context.principal.tenantId);
  };
  const calls = new Map<string, AssistantDriverToolCall>();
  const completed = new Set<string>();
  const approvalRequested = new Set<string>();
  const approvals = new Map<string, AssistantApprovalRequest>();
  const approved = new Set<string>();
  let text = '';
  let final:
    | { text: string; usage?: ToolLoopUsage; workRun?: WorkRunMetadata }
    | undefined;
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
      metadata: { ...metadata, ...author.metadata },
    });
    const wire = serialize(message);
    emit({ type: 'message', message: wire });
    return wire;
  };
  const callbacks: AssistantTurnDriverCallbacks = {
    execution(metadata) {
      observed = metadata;
    },
    text(delta) {
      if (!active() || !delta) return;
      text += delta;
      emit({ type: 'token', text: delta });
    },
    toolCall: (call) =>
      enqueue(async () => {
        if (
          !offered.has(call.name) ||
          !enabled(call.name) ||
          calls.has(call.id)
        ) {
          throw new Error(
            'The external driver reported an unoffered or duplicate tool call.',
          );
        }
        calls.set(call.id, structuredClone(call));
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
        if (result.ok && !enabled(call.name))
          throw new Error('The external tool model is no longer enabled.');
        if (
          result.ok &&
          context.requiresApproval(call.name, call.args) &&
          !approved.has(call.id)
        ) {
          throw new Error(
            'A protected tool result requires an owner decision.',
          );
        }
        completed.add(result.id);
        completedHistory.push(
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: result.result ?? result.error ?? '',
          },
        );
        const approval = approvals.get(result.id);
        if (approval && approved.has(result.id))
          await options.approvals?.complete?.(
            approval,
            result.ok,
            result.result ?? result.error ?? '',
          );
        emit({
          type: 'step',
          step: {
            kind: 'tool_result',
            callId: call.id,
            tool: call.name,
            label: describe(call.name, call.args, {
              ok: result.ok,
              observation: result.result,
            }),
            ok: result.ok,
            ...(result.error ? { error: result.error } : {}),
          },
        });
        const label = describe(call.name, call.args, {
          ok: result.ok,
          observation: result.result,
        });
        await persist(label, 'tool_result', {
          id: call.id,
          name: call.name,
          args: call.args,
          status: result.ok ? 'success' : 'error',
          label,
        });
      }),
    async approvalNeeded(request) {
      await pending;
      if (!active()) return { approved: false, reason: 'cancelled' };
      const call = calls.get(request.callId);
      if (
        !call ||
        call.name !== request.tool ||
        completed.has(call.id) ||
        approvalRequested.has(call.id)
      ) {
        throw new Error(
          'The external driver requested approval for an unmatched tool call.',
        );
      }
      approvalRequested.add(call.id);
      const tool = [...context.tools, ...context.extraTools].find(
        (tool) => tool.slug === call.name,
      );
      if (!tool || !enabled(call.name))
        throw new Error('Approval requires an enabled offered tool.');
      const bridge =
        options.approvals && context.requiresApproval(call.name, call.args)
          ? options.approvals
          : undefined;
      const approval = bridge
        ? await bridge.request({
            id: call.id,
            tool,
            args: call.args,
            ...(context.permissions
              ? { permissions: context.permissions }
              : {}),
            ...(options.originMessageId
              ? { originMessageId: options.originMessageId }
              : {}),
          })
        : request;
      if (bridge) approvals.set(call.id, approval);
      await persist(approval.summary, 'tool_call', {
        id: call.id,
        name: call.name,
        args: call.args,
        approval,
      });
      emit({ type: 'approval_needed', approval });
      const waiter = options.waitForApproval ?? driver.waitForApproval;
      if (!waiter && !bridge?.wait)
        return { approved: false, reason: 'approval_unavailable' };
      // The same abort race that stops the driver also releases an approval wait.
      const decision = await Promise.race([
        bridge?.wait
          ? bridge.wait(approval, context)
          : waiter!(approval, context),
        aborted.then(() => ({ approved: false, reason: 'cancelled' })),
      ]);
      if (decision.approved && !enabled(call.name)) {
        // A chat bridge has consumed this decision; make the refusal terminal.
        // Host-owned observers have no bridge and retain their own ledger authority.
        await bridge?.complete?.(approval, false, {
          status: 'refused',
          error: 'The approved tool is no longer enabled.',
        });
        return { approved: false, reason: 'model_disabled' };
      }
      if (decision.approved) approved.add(call.id);
      return decision;
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
      const running = driver.run(context, callbacks);
      await Promise.race([running, aborted]);
      // Escalation must revoke/settle the old pass before minting a new binding.
      if (escalation) await running.catch(() => {});
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
  const tokens =
    observed?.tokens ?? final?.workRun?.tokens ?? final?.usage?.totalTokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0)
    accounting.usageKnown = false;
  else accounting.tokens += tokens;
  accounting.toolCalls += observed?.toolCalls ?? completed.size;
  if (escalation) {
    escalation.workRun = observed ?? final?.workRun;
    escalation.messages = [
      ...context.history,
      { role: 'user', content: context.userMessage },
      ...completedHistory,
    ];
    throw escalation;
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
    throw failed
      ? failure
      : new Error('The external driver returned without done.');
  }
  const reply = resolveTurnReply(
    { content: final.text },
    options.emptyAnswerFallback,
  );
  const formatted = !reply.fallback
    ? options.formatAssistantReply?.(reply.content)
    : undefined;
  const content = formatted?.content ?? reply.content;
  const stoppedReason = reply.fallback ? 'empty' : 'stop';
  const { tokens: _tokens, ...observedMetadata } =
    observed ?? final.workRun ?? {};
  const workRun = options.workProfile
    ? {
        ...observedMetadata,
        profile: options.workProfile.name,
        engine: options.workProfile.engine,
        effort: options.workProfile.effort,
        durationMs: Date.now() - startedAt,
        ...((observed?.model ?? final.workRun?.model)
          ? { model: observed?.model ?? final.workRun?.model }
          : {}),
        ...(accounting.usageKnown ? { tokens: accounting.tokens } : {}),
        toolCalls: accounting.toolCalls,
      }
    : undefined;
  if (workRun) {
    try {
      (
        options.onWorkRun ??
        // biome-ignore lint/suspicious/noConsole: sanitized turn accounting defaults to the server log; hosts may supply onWorkRun
        ((value) => console.info('assistant.workRun', value))
      )(workRun);
    } catch {
      /* Telemetry never breaks a turn. */
    }
  }
  const message = await persist(content, 'text', undefined, {
    ...replyMetadataFor({ stoppedReason }, reply),
    ...formatted?.metadata,
    ...(workRun ? { workRun } : {}),
  });
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

/** Persist the human handoff and the intercepted assist work before the durable job takes over. */
export async function recordDesignHandoff<M>(
  options: AssistantTurnOptions<M>,
  accepted: { runId: string; message?: string },
  emit: (event: AssistantTurnEvent<M>) => void,
  serialize: (message: unknown) => M,
  observed?: WorkRunMetadata,
): Promise<{ content: string; message?: M }> {
  const content = accepted.message ?? 'Thinking this through';
  const accounting = options[WORK_RUN_ACCOUNTING];
  const profile = options.workProfile;
  const model = observed?.model ?? accounting?.model;
  const workRun: WorkRunMetadata | undefined =
    profile && accounting
      ? {
          profile: profile.name,
          engine: profile.engine,
          effort: profile.effort,
          ...(model ? { model } : {}),
          ...(observed?.fallback ? { fallback: observed.fallback } : {}),
          durationMs: Date.now() - accounting.startedAt,
          toolCalls: accounting.toolCalls,
          ...(accounting.usageKnown ? { tokens: accounting.tokens } : {}),
        }
      : undefined;
  if (workRun) {
    try {
      (
        options.onWorkRun ??
        // biome-ignore lint/suspicious/noConsole: sanitized turn accounting defaults to server logging
        ((value) => console.info('assistant.workRun', value))
      )(workRun);
    } catch {
      /* Accounting never breaks a turn. */
    }
  }
  let message: M | undefined;
  if (options.author) {
    const author = options.author;
    message = serialize(
      await sendAgentReply(author.chatService, {
        tenantId: author.tenantId,
        agentSessionId: author.agentSessionId,
        threadId: author.threadId ?? null,
        replyToMessageId: options.originMessageId ?? null,
        kind: 'assistant',
        content,
        metadata: {
          ...author.metadata,
          designRunId: accepted.runId,
          ...(workRun ? { workRun } : {}),
        },
      }),
    );
    emit({ type: 'message', message });
  }
  return { content, ...(message ? { message } : {}) };
}

/** Restart once with the same authority after a host-boundary design interception. */
export async function runExternalAssistantTurn<M>(
  options: AssistantTurnOptions<M>,
  emit: (event: AssistantTurnEvent<M>) => void,
  serialize: (message: unknown) => M,
  describe: DescribeAssistantTool,
  report: (state: AssistantTurnState['state']) => Promise<boolean>,
): Promise<AssistantTurnResult> {
  options = {
    ...options,
    [WORK_RUN_ACCOUNTING]: options[WORK_RUN_ACCOUNTING] ?? {
      startedAt: Date.now(),
      tokens: 0,
      usageKnown: true,
      toolCalls: 0,
    },
  };
  try {
    return await runExternalAssistantAttempt(
      options,
      emit,
      serialize,
      describe,
      report,
    );
  } catch (error) {
    if (
      !(error instanceof WorkProfileEscalation) ||
      (!options.resolveWorkProfile && !options.onDesignEscalation)
    )
      throw error;
    if (options.onDesignEscalation) {
      const accepted = await options.onDesignEscalation({
        tool: error.tool,
        history: error.messages ?? options.history ?? [],
        userMessage: options.userMessage,
        thread: options.thread,
        originMessageId: options.originMessageId,
      });
      const { content, message } = await recordDesignHandoff(
        options,
        accepted,
        emit,
        serialize,
        error.workRun,
      );
      emit({
        type: 'status',
        status: { state: 'working', label: content, cancellable: true },
      });
      await report('completed');
      emit({
        type: 'done',
        stoppedReason: 'stop',
        runId: accepted.runId,
        ...(message ? { message } : {}),
      });
      return {
        content,
        stoppedReason: 'stop',
        originMessageId: options.originMessageId,
        runId: accepted.runId,
      };
    }
    const workProfile = await options.resolveWorkProfile!('design');
    if (workProfile.name !== 'design')
      throw new Error('Design escalation requires the design profile.');
    emit({
      type: 'status',
      status: {
        state: 'working',
        label: 'Thinking this through',
        cancellable: true,
      },
    });
    const runtime = await options.resolveWorkProfileRuntime?.(workProfile);
    const next = {
      ...options,
      ...runtime,
      workProfile,
      history: error.messages ?? options.history,
    };
    if (next.turnDriver)
      return runExternalAssistantAttempt(
        next,
        emit,
        serialize,
        describe,
        report,
      );
    const turn = runAssistantTurn(next);
    while (true) {
      const item = await turn.next();
      if (item.done) return item.value;
      emit(item.value);
    }
  }
}
