import {
  type AgentEngineDeps,
  runAgentTurn as runInferenceAgentTurn,
} from '@happyvertical/smrt-inference/server';
import type { TurnEvent, TurnStop } from '../../assistant/events.ts';
import {
  reportLink,
  reportPresentation,
  toolSummary,
} from '../../assistant/tool-summary.ts';
import type { AssistantThread } from '../../objects/AssistantThread.ts';
import type { AgentTool } from '../agent-cli/tools.ts';
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

export {
  type AgentEngineDeps,
  type AgentTurnLimits,
  DEFAULT_AGENT_LIMITS,
  tokenFailureMessage,
} from '@happyvertical/smrt-inference/server';

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

export interface AgentTurnOptions {
  principal: Principal;
  thread: AssistantThread;
  text: string;
  tool: AgentTool;
  mcpUrl: string;
  signal: AbortSignal;
  emit(event: TurnEvent): void;
  deps: AgentEngineDeps;
}

/** Shell persistence, draft targeting and approval presentation for the shared engine. */
export async function runAgentTurn(
  options: AgentTurnOptions,
): Promise<TurnStop> {
  let changedIn: ModeContext | null = null;
  return runInferenceAgentTurn({
    ...options,
    emit(event) {
      if (event.type === 'tool_result') {
        const { details, ...rest } = event;
        const copy = details?.copy;
        options.emit({
          ...rest,
          ...(details?.report
            ? {
                report: details.report as NonNullable<
                  Extract<TurnEvent, { type: 'tool_result' }>['report']
                >,
              }
            : {}),
          ...(copy === 'live' || copy === 'draft' ? { copy } : {}),
        });
      } else options.emit(event);
    },
    host: {
      appendMessage: (message) => {
        if (
          message.role === 'tool' &&
          message.meta &&
          'name' in message.meta &&
          message.meta.name === 'app_runreport'
        ) {
          const { report: _report, ...meta } =
            message.meta as typeof message.meta & { report?: unknown };
          return appendMessage(options.thread, {
            ...message,
            content: meta.summary,
            meta,
          });
        }
        return appendMessage(options.thread, message);
      },
      lastSession: () =>
        lastCliSession(options.thread.id as string, options.tool),
      async guidance() {
        const mode = await assistantMode(options.principal);
        return {
          systemPrompt: agentSystemPrompt(mode),
          prompt: turnInput(options.text, mode),
        };
      },
      allowTool: (name) => !ASSISTANT_DENIED_TOOLS.has(name),
      approvals: {
        subscribe: (listener) =>
          subscribe((event) => {
            if (event.type === 'approval') listener(event);
          }),
        get: getApprovalView,
      },
      async describeResult({ name, text, ok, approvalId }) {
        const summary = approvalId
          ? 'Waiting for your decision'
          : toolSummary(name, text, ok);
        const mode = approvalId ? null : await assistantMode(options.principal);
        const structural = STRUCTURAL_TOOLS.has(name);
        const copy = !mode?.draft
          ? undefined
          : structural
            ? mode.scope.structure
            : /^(app|approval)_/.test(name) && name !== 'app_runreport'
              ? undefined
              : mode.scope.records;
        if (mode?.draft && structural && ok) changedIn = mode;
        const report = reportPresentation(name, text, ok);
        return {
          summary,
          details: {
            ...(copy ? { copy } : {}),
            ...(report
              ? {
                  report,
                  ...(reportLink(report.href)
                    ? { reportHref: report.href }
                    : {}),
                }
              : {}),
          },
        };
      },
      async completionNote() {
        return changedIn ? copyNote(changedIn) : null;
      },
    },
  });
}
