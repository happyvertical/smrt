// One assistant turn through a LOCAL AGENT CLI (the person's own Claude Code
// or Codex): the second engine beside the API-key loop in turn.ts.
//
// The CLI runs its own loop. What it can do is exactly what the shell's MCP
// route offers the owner (builder tools + the app's tools, the same policy as
// `/mcp` and the API engine), reached with a short-lived owner-bound token.
// Approval stays the shell's gate: a risky call comes back from `/mcp` as
// `pending_approval` and an Approval is stored; this turn shows its card
// (`approval_required`) and never applies it. Only the owner's decision in the
// UI does, through `Approval.decide`. The turn then ends `waiting` and the CLI
// has been told (by the tool result) not to retry.
//
// Wire contract is unchanged (TurnEvent), so the dock needs no engine code.

import type { AIToolCall } from '@happyvertical/ai';
import type { TurnEvent, TurnStop } from '../../assistant/events.ts';
import { toolSummary } from '../../assistant/tool-summary.ts';
import type { AssistantThread } from '../../objects/AssistantThread.ts';
import type { AgentCredentials } from '../agent-cli/credentials.ts';
import type { AgentCliLocation } from '../agent-cli/detect.ts';
import { runProcess } from '../agent-cli/runner.ts';
import { buildAgentRun } from '../agent-cli/session.ts';
import type { AgentEvent } from '../agent-cli/stream.ts';
import { AGENT_TOOL_INFO, type AgentTool } from '../agent-cli/tools.ts';
import { getApprovalView } from '../approvals.ts';
import { subscribe } from '../events.ts';
import type { Principal } from '../owner.ts';
import { systemPrompt, turnInput } from './guidance.ts';
import {
  assistantMode,
  copyNote,
  LIVE_MODE,
  type ModeContext,
  STRUCTURAL_TOOLS,
} from './scope.ts';
import { appendMessage, lastCliSession } from './threads.ts';
import { ASSISTANT_DENIED_TOOLS } from './turn.ts';

export interface AgentTurnLimits {
  /** The whole turn, CLI start to exit. */
  turnTimeoutMs: number;
  toolResultChars: number;
}

export const DEFAULT_AGENT_LIMITS: AgentTurnLimits = {
  turnTimeoutMs: 10 * 60_000,
  toolResultChars: 12_000,
};

/** What the CLI engine needs from its host (production wiring in routes.ts). */
export interface AgentEngineDeps {
  locate(tool: AgentTool): Promise<AgentCliLocation | null>;
  credentials: AgentCredentials;
  /** `<data root>/agent-cli`. */
  stateDir(): Promise<string>;
  /** Base environment for the child (allow-listed again inside). */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  limits?: Partial<AgentTurnLimits>;
}

const ADDENDUM = `
## How you are connected

You run as a headless helper inside the person's app. Your only tools are the
app's own tools (the app builder and the app's records). You have no shell, no
files and no web. If a tool answers \`pending_approval\`, the change is waiting
for the person's Approve or Deny card: say in one sentence what is waiting, then
stop. Do not call it again and do not look for another way to apply it.`;

export function agentSystemPrompt(mode: ModeContext = LIVE_MODE): string {
  return `${systemPrompt(mode)}\n${ADDENDUM}`;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} [cut]` : text;
}

export interface AgentTurnOptions {
  principal: Principal;
  thread: AssistantThread;
  text: string;
  tool: AgentTool;
  /** The shell's own `/mcp` URL (loopback only). */
  mcpUrl: string;
  signal: AbortSignal;
  emit(event: TurnEvent): void;
  deps: AgentEngineDeps;
}

/** Run one turn to its end. Never throws for CLI, tool or abort failures. */
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

export async function runAgentTurn(
  options: AgentTurnOptions,
): Promise<TurnStop> {
  const { thread, emit, tool, deps } = options;
  const limits = { ...DEFAULT_AGENT_LIMITS, ...deps.limits };
  const label = AGENT_TOOL_INFO[tool].label;
  const fail = (code: string, message: string, stop: TurnStop = 'error') => {
    emit({ type: 'error', code, message });
    emit({ type: 'done', stop });
    return stop;
  };

  await appendMessage(thread, { role: 'user', content: options.text });

  const location = await deps.locate(tool);
  if (!location)
    return fail(
      'agent_cli_missing',
      `${label} is not installed on this computer.`,
    );

  const threadId = thread.id as string;
  let resumeId = await lastCliSession(threadId, tool);

  let token: string;
  try {
    token = await deps.credentials.mint();
  } catch (error) {
    const code = tokenFailureCode(error);
    // biome-ignore lint/suspicious/noConsole: class and stable code only, never a message
    console.error(
      'assistant token failed:',
      error instanceof Error ? error.name : 'unknown',
      code ?? 'no_code',
    );
    return fail('agent_cli_token', tokenFailureMessage(code));
  }

  // Approvals created (and decided) while the CLI runs, from the in-process bus.
  const raised: { approvalId: string; attached: boolean }[] = [];
  const toolIdOf = new Map<string, string>();
  const unsubscribe = subscribe((e) => {
    if (e.type !== 'approval') return;
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

  let changedIn: ModeContext | null = null;
  let pendingText = '';
  let streamedAny = false;
  let sawTool = false;
  let stop = 'complete' as TurnStop;
  let sessionId: string | null = null;
  let finished: Extract<AgentEvent, { type: 'done' }> | null = null;
  const names = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) controller.abort();

  const handle = async (event: AgentEvent): Promise<void> => {
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
        if (ASSISTANT_DENIED_TOOLS.has(event.name)) {
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
        await appendMessage(thread, {
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
          const view = await getApprovalView(fresh.approvalId);
          if (view?.status === 'pending') {
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
        const summary = approvalId
          ? 'Waiting for your decision'
          : toolSummary(name, event.text, event.ok);
        // Which copy it acted on (the /mcp scope=assistant request resolved it
        // from the same state), so the card and the closing note can say so.
        const mode = approvalId ? null : await assistantMode(options.principal);
        const structural = STRUCTURAL_TOOLS.has(name);
        const copy = !mode?.draft
          ? undefined
          : structural
            ? mode.scope.structure
            : /^(app|approval)_/.test(name)
              ? undefined
              : mode.scope.records;
        if (mode?.draft && structural && event.ok) changedIn = mode;
        emit({
          type: 'tool_result',
          id: event.id,
          name,
          ok: event.ok,
          summary,
          ...(copy ? { copy } : {}),
        });
        await appendMessage(thread, {
          role: 'tool',
          content: text,
          toolCallId: event.id,
          meta: {
            id: event.id,
            name,
            ok: event.ok,
            summary,
            ...(copy ? { copy } : {}),
            ...(approvalId ? { approvalId } : {}),
          },
        });
        return;
      }
      case 'done':
        finished = event;
        return;
    }
  };

  const attempt = async (resume: string | null) => {
    const mode = await assistantMode(options.principal);
    const spec = buildAgentRun({
      tool,
      location,
      stateDir: await deps.stateDir(),
      mcpUrl: options.mcpUrl,
      token,
      systemPrompt: agentSystemPrompt(mode),
      prompt: turnInput(options.text, mode),
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
        timeoutMs: limits.turnTimeoutMs,
        onStdoutLine: (line) => {
          const events = spec.parse(line);
          // One at a time, in order, even though lines arrive synchronously.
          queue = queue.then(async () => {
            for (const e of events) await handle(e);
          });
        },
      });
    } finally {
      spec.cleanup();
    }
  };

  try {
    let result = await attempt(resumeId);
    await queue;
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
      // biome-ignore lint/suspicious/noConsole: exit class only, never output
      console.error(
        'assistant cli turn failed:',
        tool,
        result.exitCode ?? result.termination,
      );
      emit({
        type: 'error',
        code: 'agent_cli_failed',
        message: `${label} could not finish. If you signed out, connect it again.`,
      });
      stop = 'error';
    } else {
      let waiting = false;
      for (const r of raised) {
        if ((await getApprovalView(r.approvalId))?.status === 'pending')
          waiting = true;
      }
      stop = waiting ? 'waiting' : 'complete';
    }
    // A structural change made while a draft was open: say which copy it was.
    const note = changedIn ? copyNote(changedIn) : null;
    if (note) {
      pendingText += `${pendingText ? '\n\n' : ''}${note}`;
      emit({ type: 'text', delta: `\n\n${note}` });
    }
    if (pendingText || sessionId)
      await appendMessage(thread, {
        role: 'assistant',
        content: pendingText,
        ...(sessionId ? { meta: { cliSession: { tool, id: sessionId } } } : {}),
      });
    emit({ type: 'done', stop });
    return stop;
  } finally {
    unsubscribe();
    options.signal.removeEventListener('abort', onAbort);
    await deps.credentials.revoke();
  }
}
