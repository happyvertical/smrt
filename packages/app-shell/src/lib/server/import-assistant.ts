/** Bind workbook planning to the owner's assistant engine; chat owns the turn. */
import { join } from 'node:path';
import {
  type AssistantTurnDriver,
  chatClientForTracking,
  runWorkflowStepTurn,
  type WorkflowStepTurnOptions,
} from '@happyvertical/smrt-chat';
import {
  createAgentCliTurnDriver,
  createChatGPTAssistantAI,
} from '@happyvertical/smrt-chat/engines';
import {
  createTrackedAiClient,
  type TrackedAiClient,
} from '@happyvertical/smrt-core';
import {
  type AgentEngineDeps,
  engineTierModel,
  resolveEngineEffort,
  tokenCredentials,
} from '@happyvertical/smrt-inference/server';
import type { ResolvedPrompt } from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { AssistantEngineId } from '../assistant/events.ts';
import { cliStatus } from './agent-cli/service.ts';
import {
  resolveAssistantOptions,
  resolveChatGPTAssistantModel,
} from './assistant/config.ts';
import { assistantEngine, statusFor } from './assistant/engine.ts';
import { productionAgent } from './assistant/routes.ts';
import {
  CHATGPT_SETTINGS_HREF,
  CHATGPT_TOOL_NAMESPACE,
  chatgptConnection,
} from './chatgpt.ts';
import { HttpError } from './http.ts';
import type { Principal } from './owner.ts';

export interface ImportAssistantOptions {
  engine?: (owner: Principal) => Promise<AssistantEngineId>;
  agent?: AgentEngineDeps;
  origin?: () => Promise<string | undefined>;
  /** Tests: a scripted external driver; production uses the shared CLI adapter. */
  driver?: AssistantTurnDriver;
}

/**
 * A local agent CLI driver for ONE tool-free turn: the only MCP endpoint it is
 * offered is `/mcp?scope=import-plan`, which has no tools (every call denied),
 * under a one-use `assistant.use` token. Shared by workbook planning and the
 * changes-waiting review; neither can reach any tool, approval or apply.
 */
export function createToollessCliDriver(input: {
  tool: 'claude-code' | 'codex';
  root: string;
  origin: () => Promise<string | undefined>;
  agent?: AgentEngineDeps;
  /** Prefix of the per-attempt token holder (at most 80 characters in all). */
  holder: string;
  label: string;
}): AssistantTurnDriver {
  return createAgentCliTurnDriver({
    tool: input.tool,
    async bind() {
      const origin = await input.origin();
      if (!origin) throw new Error('The local app origin is unavailable');
      const agent = input.agent ?? productionAgent();
      // A distinct holder per attempt: a late old worker cannot revoke
      // the new attempt's token. The only MCP endpoint offered has NO tools.
      const deps = input.agent
        ? agent
        : {
            ...agent,
            credentials: tokenCredentials(
              async () => {
                const { runtime } = await import('./smrt.ts');
                return (await runtime.localRuntime()).mcpTokens;
              },
              {
                // One UUID already isolates this attempt from every other worker.
                holder: `${input.holder}-${crypto.randomUUID()}`,
                scopes: ['assistant.use'],
                label: input.label,
              },
            ),
            stateDir: async () => join(input.root, 'agent-cli'),
          };
      return {
        mcpUrl: new URL('/mcp?scope=import-plan', origin).href,
        deps,
        outputSchema: undefined,
        // The caller validates the JSON itself. Native schema modes must not
        // replace the plain JSON response.
        allowTool: () => false,
        approvals: {
          subscribe: () => () => {},
          get: async () => null,
        },
      };
    },
  });
}

/** Host binding only: no model loop, accounting, tool execution or persistence here. */
export function createImportAssistant(
  options: ImportAssistantOptions & {
    db: DatabaseInterface;
    root: string;
  },
) {
  const engineOf = options.engine ?? assistantEngine;
  return {
    async ready(owner: Principal) {
      const engine = await engineOf(owner);
      const status = await statusFor(engine, owner, {
        config: { tier: 'best' },
        cliStatus,
      });
      if (!status.configured) {
        const next =
          engine === 'chatgpt'
            ? 'Sign in with ChatGPT in Settings → Assistant, then try importing again.'
            : engine === 'api'
              ? 'Add an API key in Settings → Inference, or choose a connected engine in Settings → Assistant.'
              : 'Connect your local AI in Settings → Assistant, then try importing again.';
        throw new HttpError(
          409,
          `${status.message ?? 'Your assistant is not connected.'} ${next}`,
        );
      }
    },
    async plan(
      owner: Principal,
      input: {
        prompt: ResolvedPrompt;
        parent: WorkflowStepTurnOptions['tracking']['parent'];
        signal: AbortSignal;
        origin?: string;
        tracked?: TrackedAiClient;
      },
    ) {
      const engine = await engineOf(owner);
      const model =
        engine === 'chatgpt'
          ? await resolveChatGPTAssistantModel(owner, { tier: 'best' })
          : engineTierModel({ engine, tier: 'best' });
      const selection = {
        engine,
        tier: 'best' as const,
        ...(model ? { model } : {}),
        ...(resolveEngineEffort({
          tier: 'best',
          prompt: input.prompt.ai.effort,
        })
          ? {
              effort: resolveEngineEffort({
                tier: 'best',
                prompt: input.prompt.ai.effort,
              }),
            }
          : {}),
      };
      const ai =
        engine === 'chatgpt'
          ? await createChatGPTAssistantAI({
              connection: await chatgptConnection(),
              model,
              tier: 'best',
              toolNamespace: CHATGPT_TOOL_NAMESPACE,
              settingsHref: CHATGPT_SETTINGS_HREF,
            })
          : undefined;
      const tracked =
        input.tracked ??
        createTrackedAiClient({
          db: options.db,
          tenantId: owner.tenantId,
          className: 'AppShellImport',
          transcript: false,
          ...(engine === 'api'
            ? { ai: await resolveAssistantOptions(owner, { tier: 'best' }) }
            : ai
              ? { ai: chatClientForTracking(ai) }
              : {}),
          ...(engine !== 'api'
            ? { label: { provider: engine, ...(model ? { model } : {}) } }
            : {}),
        });
      const turnDriver =
        engine === 'claude-code' || engine === 'codex'
          ? (options.driver ??
            createToollessCliDriver({
              tool: engine,
              root: options.root,
              origin: async () => (await options.origin?.()) ?? input.origin,
              agent: options.agent,
              holder: 'import-plan',
              label: 'Workbook planning',
            }))
          : undefined;
      return runWorkflowStepTurn({
        // The built-in runner replaces ai with the tracked client before calling it.
        ai: ai ?? {
          chat: async () => {
            throw new Error('Unbound import model');
          },
        },
        ...(turnDriver ? { turnDriver } : {}),
        principal: {
          runAsUserId: owner.id,
          tenantId: owner.tenantId,
          allowedTools: [],
        },
        selection,
        signal: input.signal,
        maxTokens: 32_768,
        tracking: { tracked, prompt: input.prompt, parent: input.parent },
      });
    },
  };
}
