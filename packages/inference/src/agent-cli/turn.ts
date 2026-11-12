// One subprocess-owned turn. Hosts own authenticated persistence, guidance,
// tool policy and approval authority; this engine never decides an approval.
import { randomUUID } from 'node:crypto';
import type { AIToolCall } from '@happyvertical/ai';
import {
  type ResolvedWorkProfile,
  runWorkModelWithFallback,
  validateWorkModel,
  type WorkModelFallbackStore,
  type WorkRunMetadata,
} from '../work-profiles.js';
import type { AgentCredentials } from './credentials.js';
import type { AgentCliLocation } from './detect.js';
import { runProcess } from './runner.js';
import { buildAgentRun } from './session.js';
import type { AgentEvent } from './stream.js';
import { AGENT_TOOL_INFO, type AgentTool } from './tools.js';

export type AgentTurnStop =
  | 'complete'
  | 'timeout'
  | 'aborted'
  | 'waiting'
  | 'error';
export type AgentTurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      details?: Record<string, unknown>;
    }
  | {
      type: 'approval_required';
      id: string;
      name: string;
      approvalId: string;
      summary: string;
      preview: unknown;
    }
  | {
      type: 'approval_decided';
      id: string;
      approvalId: string;
      status: 'approved' | 'denied' | 'failed' | 'timeout';
    }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; stop: AgentTurnStop };

export interface AgentTurnLimits {
  /** The whole turn, CLI start to exit. */
  turnTimeoutMs: number;
  toolResultChars: number;
}

export const DEFAULT_AGENT_LIMITS: AgentTurnLimits = {
  turnTimeoutMs: 10 * 60_000,
  toolResultChars: 12_000,
};

/** Process and token dependencies supplied by the authenticated host. */
export interface AgentEngineDeps {
  locate(tool: AgentTool): Promise<AgentCliLocation | null>;
  credentials: AgentCredentials;
  /** Private app-owned directory, outside a source/project tree. */
  stateDir(): Promise<string>;
  /** Base environment for the child (allow-listed again inside). */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  limits?: Partial<AgentTurnLimits>;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} [cut]` : text;
}

/** Persistence, guidance and approvals belong to the authenticated host. */
export interface AgentTurnHost {
  appendMessage(message: AgentTurnMessage): Promise<unknown>;
  lastSession(): Promise<string | null>;
  guidance(): Promise<{ systemPrompt: string; prompt: string }>;
  allowTool(name: string): boolean;
  approvals: {
    subscribe(
      listener: (event: {
        id: string;
        status: 'pending' | 'approved' | 'denied' | 'failed' | 'timeout';
      }) => void,
    ): () => void;
    get(id: string): Promise<{
      id: string;
      status: string;
      summary: string;
      preview: unknown;
    } | null>;
  };
  describeResult(input: {
    name: string;
    text: string;
    ok: boolean;
    approvalId?: string;
  }): Promise<{ summary: string; details?: Record<string, unknown> }>;
  recordExecution?(metadata: WorkRunMetadata): Promise<void>;
  completionNote?(): Promise<string | null>;
}

export interface AgentTurnMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: AIToolCall[];
  toolCallId?: string;
  meta?:
    | {
        id: string;
        name: string;
        ok: boolean;
        summary: string;
        approvalId?: string;
      }
    | { cliSession: { tool: string; id: string }; workRun?: WorkRunMetadata };
}

export interface AgentTurnOptions {
  text: string;
  profile?: ResolvedWorkProfile;
  outputSchema?: Record<string, unknown>;
  fallback?: {
    ownerId: string;
    connectionKey: string;
    nextModel: string;
    store: WorkModelFallbackStore;
  };
  tool: AgentTool;
  mcpUrl: string;
  signal: AbortSignal;
  emit(event: AgentTurnEvent): void;
  deps: AgentEngineDeps;
  host: AgentTurnHost;
}

/** The stable `code` of a LocalRuntimeError-shaped failure; never a message. */
function tokenFailureCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z_]{1,48}$/.test(code)
    ? code
    : undefined;
}

/** What the owner sees; a missing permission says what to do about it. */
export function tokenFailureMessage(code: string | undefined): string {
  if (code === 'invalid_scope')
    return 'The assistant could not start: the owner is missing the assistant permission. Restart the app so it can grant it, then try again.';
  if (code === 'owner_unavailable')
    return 'The assistant could not start: finish owner setup first.';
  return 'The assistant could not start. Try again.';
}

const reportedFailures = new WeakMap<object, string>();
const diagnosticCodes = new Set([
  'agent_cli_missing',
  'agent_cli_signed_out',
  'agent_cli_startup',
  'agent_cli_token',
  'agent_cli_failed',
  'agent_mcp_unavailable',
  'agent_tool_blocked',
  'timeout',
  'invalid_scope',
  'owner_unavailable',
  'runtime_unavailable',
  'cli_invocation',
  'working_directory',
  'tool_host_policy',
]);

/** Log only diagnostic structure, never a message, child output, arguments or credentials. */
export function reportAgentFailure(
  tool: AgentTool,
  phase:
    | 'binding'
    | 'process'
    | 'guard'
    | 'credential'
    | 'preflight'
    | 'driver',
  error?: unknown,
  code?: string,
): string {
  if (error && typeof error === 'object') {
    const existing = reportedFailures.get(error);
    if (existing) return existing;
  }
  const reference = randomUUID();
  const cause =
    error instanceof TypeError
      ? 'TypeError'
      : error instanceof RangeError
        ? 'RangeError'
        : error instanceof Error
          ? 'Error'
          : 'unavailable';
  // Exclude the first line (the error message). Keep code locations only, no paths.
  const sites =
    error instanceof Error
      ? (error.stack ?? '')
          .slice(0, 4096)
          .split('\n')
          .slice(1)
          .flatMap((line) => {
            const match = line.match(
              /(?:\(|\s)([^()\s]+\.[cm]?[jt]s):(\d+):(\d+)\)?$/,
            );
            if (!match) return [];
            const subsystem =
              /\/packages\/(core|chat|inference|app-runtime|users)\//.exec(
                match[1],
              )?.[1] ?? 'host';
            // Fixed subsystem labels and numeric coordinates only: even a forged
            // stack cannot smuggle a token through a filename or function name.
            return [`${subsystem}:${match[2]}:${match[3]}`];
          })
          .slice(0, 6)
      : [];
  // Codes come from this module's fixed vocabulary, never arbitrary SDK fields.
  try {
    // biome-ignore lint/suspicious/noConsole: secret-free server diagnostic, correlated to the safe wire message
    console.error('[smrt-inference] local engine failure', {
      reference,
      tool,
      phase,
      cause,
      code: code && diagnosticCodes.has(code) ? code : 'unexpected_failure',
      sites,
    });
  } catch {
    /* A failed log sink must not change cleanup or refusal. */
  }
  if (error && typeof error === 'object')
    reportedFailures.set(error, reference);
  return reference;
}

/** Run a turn and log unexpected host/process failures before preserving their cleanup contract. */
export async function runAgentTurn(
  options: AgentTurnOptions,
): Promise<AgentTurnStop> {
  try {
    return await runAgentTurnImpl(options);
  } catch (error) {
    reportAgentFailure(options.tool, 'process', error);
    throw error;
  }
}

/** Run one subprocess turn; host callback failures propagate after cleanup. */
async function runAgentTurnImpl(
  options: AgentTurnOptions,
): Promise<AgentTurnStop> {
  const { host, tool, deps } = options;
  if (
    options.profile &&
    (options.profile.engine !== tool || !options.profile.model)
  )
    throw new Error('The work profile does not match this connected engine.');
  if (options.profile?.model !== undefined)
    validateWorkModel(options.profile.model);
  if (options.fallback?.nextModel !== undefined)
    validateWorkModel(options.fallback.nextModel);
  const emit: AgentTurnOptions['emit'] = (event) => {
    if (event.type === 'error' && !event.message.includes(' Reference: ')) {
      const reference = reportAgentFailure(
        tool,
        'process',
        undefined,
        event.code,
      );
      options.emit({
        ...event,
        message: `${event.message} Reference: ${reference}`,
      });
    } else options.emit(event);
  };
  const startedAt = Date.now();
  let toolCalls = 0;
  let reportedModel: string | undefined;
  let reportedTokens: number | undefined;
  const limits = {
    ...DEFAULT_AGENT_LIMITS,
    ...(options.profile
      ? {
          turnTimeoutMs: options.profile.budgets.requestTimeoutMs,
          toolResultChars: options.profile.budgets.toolResultChars,
        }
      : {}),
    ...deps.limits,
  };
  const label = AGENT_TOOL_INFO[tool].label;
  const fail = (
    code: string,
    message: string,
    stop: AgentTurnStop = 'error',
    cause?: unknown,
  ) => {
    const causeCode = tokenFailureCode(cause);
    const reference = reportAgentFailure(
      tool,
      code === 'agent_cli_token' ? 'credential' : 'process',
      cause,
      causeCode ?? code,
    );
    // Retain the shell's safe diagnostic contract without copying arbitrary
    // Error.name or SDK codes into logs. The correlated record above is primary.
    if (
      code === 'agent_cli_token' &&
      cause instanceof Error &&
      cause.name === 'LocalRuntimeError' &&
      causeCode &&
      diagnosticCodes.has(causeCode)
    ) {
      // biome-ignore lint/suspicious/noConsole: fixed legacy tag and allow-listed code only
      console.error('assistant token failed:', 'LocalRuntimeError', causeCode);
    }
    emit({
      type: 'error',
      code,
      message: `${message} Reference: ${reference}`,
    });
    emit({ type: 'done', stop });
    return stop;
  };

  await host.appendMessage({ role: 'user', content: options.text });

  const location = await deps.locate(tool);
  if (!location)
    return fail(
      'agent_cli_missing',
      `${label} is not installed on this computer.`,
    );

  let resumeId = await host.lastSession();

  let token: string;
  try {
    token = await deps.credentials.mint({ timeoutMs: limits.turnTimeoutMs });
  } catch (error) {
    const code = tokenFailureCode(error);
    return fail('agent_cli_token', tokenFailureMessage(code), 'error', error);
  }

  let unsubscribe: (() => void) | undefined;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  try {
    // The host supplies only approval events for this authenticated turn.
    const raised: { approvalId: string; attached: boolean }[] = [];
    const toolIdOf = new Map<string, string>();
    unsubscribe = host.approvals.subscribe((e) => {
      if (e.status === 'pending') {
        raised.push({ approvalId: e.id, attached: false });
        return;
      }
      const known = raised.find((r) => r.approvalId === e.id);
      const toolId = known ? toolIdOf.get(e.id) : undefined;
      if (known && toolId)
        emit({
          type: 'approval_decided',
          id: toolId,
          approvalId: e.id,
          status: e.status,
        });
    });

    let pendingText = '';
    let streamedAny = false;
    let sawTool = false;
    let stop = 'complete' as AgentTurnStop;
    let sessionId: string | null = null;
    let finished: Extract<AgentEvent, { type: 'done' }> | null = null;
    const names = new Map<string, string>();
    let queue: Promise<void> = Promise.resolve();
    let hostFailure: { error: unknown } | undefined;
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) controller.abort();

    const handle = async (event: AgentEvent): Promise<void> => {
      if (stop === 'error' && controller.signal.aborted) return;
      switch (event.type) {
        case 'session':
          sessionId = event.id;
          return;
        case 'text':
          streamedAny = true;
          pendingText += event.delta;
          emit({ type: 'text', delta: event.delta });
          return;
        case 'message': {
          const delta = `${pendingText ? '\n\n' : ''}${event.text}`;
          streamedAny = true;
          pendingText += delta;
          emit({ type: 'text', delta });
          return;
        }
        case 'forbidden':
          // A tool outside the shell's own appeared in the stream: stop at once.
          stop = 'error';
          controller.abort();
          emit({
            type: 'error',
            code: 'agent_tool_blocked',
            message: `${label} tried to use something other than this app's tools. I stopped it.`,
          });
          return;
        case 'tool_use': {
          toolCalls++;
          if (!host.allowTool(event.name)) {
            stop = 'error';
            controller.abort();
            emit({
              type: 'error',
              code: 'agent_tool_blocked',
              message: 'The assistant cannot decide approvals. I stopped it.',
            });
            return;
          }
          sawTool = true;
          names.set(event.id, event.name);
          const call: AIToolCall = {
            id: event.id,
            type: 'function',
            function: { name: event.name, arguments: event.args },
          };
          await host.appendMessage({
            role: 'assistant',
            content: pendingText,
            toolCalls: [call],
          });
          pendingText = '';
          emit({
            type: 'tool_call',
            id: event.id,
            name: event.name,
            args: cut(event.args, 400),
          });
          return;
        }
        case 'tool_result': {
          const name = names.get(event.id) ?? '';
          const text = cut(event.text, limits.toolResultChars);
          const fresh = raised.find((r) => !r.attached);
          let approvalId: string | undefined;
          if (fresh) {
            fresh.attached = true;
            toolIdOf.set(fresh.approvalId, event.id);
            const view = await host.approvals.get(fresh.approvalId);
            // An independent owner can decide before this fast response is
            // parsed. It is still a held call, never an unapproved tool result.
            if (
              view &&
              ['pending', 'approved', 'denied', 'failed', 'timeout'].includes(
                view.status,
              )
            ) {
              approvalId = fresh.approvalId;
              emit({
                type: 'approval_required',
                id: event.id,
                name,
                approvalId: view.id,
                summary: view.summary,
                preview: view.preview,
              });
            }
          }
          const { summary, details } = await host.describeResult({
            name,
            text: event.text,
            ok: event.ok,
            approvalId,
          });
          emit({
            type: 'tool_result',
            id: event.id,
            name,
            ok: event.ok,
            summary,
            ...(details ? { details } : {}),
          });
          await host.appendMessage({
            role: 'tool',
            content: text,
            toolCallId: event.id,
            meta: {
              id: event.id,
              name,
              ok: event.ok,
              summary,
              ...details,
              ...(approvalId ? { approvalId } : {}),
            },
          });
          return;
        }
        case 'execution_model':
          reportedModel = event.model;
          return;
        case 'done':
          if (event.tokens !== undefined)
            reportedTokens = (reportedTokens ?? 0) + event.tokens;
          finished = event;
          if (!event.ok && event.error === 'tool_host_policy') {
            emit({
              type: 'error',
              code: 'tool_host_policy',
              message: `${label} cannot use the app's tools with the required security settings. Choose a compatible engine in AI settings.`,
            });
            stop = 'error';
            controller.abort();
          }
          return;
      }
    };

    const checkHostFailure = () => {
      if (hostFailure) throw hostFailure.error;
    };
    let activeProfile = options.profile;
    let fallback: WorkRunMetadata['fallback'];
    const attempt = async (resume: string | null) => {
      const guidance = await host.guidance();
      const spec = buildAgentRun({
        tool,
        profile: activeProfile,
        outputSchema: options.outputSchema,
        location,
        stateDir: await deps.stateDir(),
        mcpUrl: options.mcpUrl,
        token,
        systemPrompt: guidance.systemPrompt,
        prompt: guidance.prompt,
        resumeId: resume,
        ...(deps.baseEnv ? { baseEnv: deps.baseEnv } : {}),
      });
      sessionId = spec.sessionId;
      try {
        return await runProcess({
          command: spec.command,
          args: spec.args,
          cwd: spec.cwd,
          env: spec.env,
          stdin: spec.stdin,
          signal: controller.signal,
          timeoutMs: Math.max(
            1,
            limits.turnTimeoutMs - (Date.now() - startedAt),
          ),
          onStdoutLine: (line) => {
            const events = spec.parse(line);
            // One at a time, in order, even though lines arrive synchronously.
            queue = queue
              .then(async () => {
                if (hostFailure) return;
                for (const e of events) await handle(e);
              })
              .catch((error: unknown) => {
                hostFailure = { error };
                controller.abort();
              });
          },
        });
      } finally {
        spec.cleanup();
      }
    };

    let result: Awaited<ReturnType<typeof attempt>>;
    const requestedProfile = options.profile;
    if (options.fallback && requestedProfile) {
      const outcome = await runWorkModelWithFallback({
        ...options.fallback,
        profile: requestedProfile,
        execute: async (model, activity) => {
          activeProfile = { ...requestedProfile, model };
          finished = null;
          reportedModel = undefined;
          const result = await attempt(resumeId);
          await queue;
          checkHostFailure();
          if (streamedAny) activity.markOutput();
          if (toolCalls > 0 || controller.signal.aborted)
            activity.markToolExecution();
          if (
            (finished as { error?: string } | null)?.error ===
            'plan_model_refused'
          )
            throw Object.assign(new Error('Plan model refused'), {
              code: 'plan_model_refused',
            });
          return result;
        },
        isPlanModelRefusal: (error) =>
          (error as { code?: string })?.code === 'plan_model_refused',
        notify: (message) => emit({ type: 'text', delta: `${message}\n\n` }),
      });
      result = outcome.result;
      fallback = outcome.fallback;
    } else result = await attempt(resumeId);
    await queue;
    checkHostFailure();
    // The tool forgot an old session (its own housekeeping): start a new one.
    if (
      resumeId &&
      !controller.signal.aborted &&
      !streamedAny &&
      !sawTool &&
      (result.exitCode !== 0 ||
        (finished as { ok: boolean } | null)?.ok === false)
    ) {
      resumeId = null;
      finished = null;
      result = await attempt(null);
      await queue;
      checkHostFailure();
    }
    const done = finished as Extract<AgentEvent, { type: 'done' }> | null;
    if (!streamedAny && done?.ok && done.text) {
      pendingText += done.text;
      emit({ type: 'text', delta: done.text });
    }
    if (
      stop === 'error' &&
      controller.signal.aborted &&
      !options.signal.aborted
    ) {
      // forbidden: already reported
    } else if (options.signal.aborted || result.aborted) {
      stop = 'aborted';
    } else if (result.timedOut) {
      emit({
        type: 'error',
        code: 'timeout',
        message: 'The assistant took too long.',
      });
      stop = 'timeout';
    } else if (result.spawnError) {
      emit({
        type: 'error',
        code: 'agent_cli_failed',
        message: `${label} could not be started.`,
      });
      stop = 'error';
    } else if (done ? !done.ok : result.exitCode !== 0) {
      const mcpUnavailable =
        result.stderrTail.includes('MCP startup failed') ||
        done?.error?.includes('MCP startup failed') === true;
      // biome-ignore lint/suspicious/noConsole: exit class only, never output
      console.error(
        'assistant cli turn failed:',
        tool,
        result.exitCode ?? result.termination,
      );
      emit({
        type: 'error',
        code: mcpUnavailable ? 'agent_mcp_unavailable' : 'agent_cli_failed',
        message: mcpUnavailable
          ? `${label} could not connect to the app's tools. Restart the app, then try again.`
          : `${label} could not finish. If you signed out, connect it again.`,
      });
      stop = 'error';
    } else {
      let waiting = false;
      for (const r of raised) {
        if ((await host.approvals.get(r.approvalId))?.status === 'pending')
          waiting = true;
      }
      stop = waiting ? 'waiting' : 'complete';
    }
    // A structural change made while a draft was open: say which copy it was.
    const note = await host.completionNote?.();
    if (note) {
      pendingText += `${pendingText ? '\n\n' : ''}${note}`;
      emit({ type: 'text', delta: `\n\n${note}` });
    }
    const execution: WorkRunMetadata | undefined = options.profile
      ? {
          profile: options.profile.name,
          engine: tool,
          model: reportedModel,
          requestedModel: activeProfile?.model,
          ...(fallback ? { fallback } : {}),
          effort: options.profile.effort,
          durationMs: Date.now() - startedAt,
          toolCalls,
          ...(reportedTokens !== undefined ? { tokens: reportedTokens } : {}),
        }
      : undefined;
    if (pendingText || sessionId || execution)
      await host.appendMessage({
        role: 'assistant',
        content: pendingText,
        ...(sessionId
          ? {
              meta: {
                cliSession: { tool, id: sessionId },
                ...(execution ? { workRun: execution } : {}),
              },
            }
          : {}),
      });
    if (execution) await host.recordExecution?.(execution);
    emit({ type: 'done', stop });
    return stop;
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    try {
      unsubscribe?.();
    } finally {
      await deps.credentials.revoke();
    }
  }
}
