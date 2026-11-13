import type { ConnectAiState } from '@happyvertical/smrt-svelte/connect-ai';
import { mountConnectAiRoutes } from '@happyvertical/smrt-svelte/connect-ai/server';
// First-run onboarding and the assistant's engine choice, as owner-only JSON
// handlers (the route files under `src/routes/api/shell/onboarding/` are
// one-liners over these).
//
//   GET  /api/shell/onboarding[?fresh=1]  -> { onboarding, engine, apiReady,
//                                             tools: [{ tool, label, installed,
//                                             version?, signedIn, installUrl,
//                                             login }] }
//   POST /api/shell/onboarding/connect    { tool }
//        -> { result: 'ready' | 'login_started' | 'login_running' | 'missing' }
//   POST /api/shell/onboarding/engine     { engine }  -> { engine }
//   GET  /api/shell/onboarding/chatgpt    -> { chatgpt, model, models? }
//   POST /api/shell/onboarding/chatgpt    { action: 'start' | 'sign-out' |
//                                         'model', model? }
//        start -> { result: 'login_started', opened, authorizationUrl? }
//   POST /api/shell/onboarding/complete   { start: 'fresh' | 'wizard' }
//   POST /api/shell/onboarding/skip       -> { onboarding: 'skipped' }
//
// Sign in with ChatGPT (a preview for open source apps) opens OpenAI's own page:
// under the desktop wrapper this process opens the system browser, in a plain
// browser session the page gets the address for a normal new-tab link. The
// SDK's loopback listener receives the callback; no token is ever returned.
//
// "Connect" never handles a credential: it uses the CLI that is already on
// this machine and, when it is signed out, starts that CLI's OWN sign-in (it
// opens the vendor's page in the system browser). See agent-cli/tools.ts.
import type { AssistantEngineId } from '../assistant/events.ts';
import {
  agentLogin,
  allCliStatus,
  asSettingsOwner,
  assistantSettings,
  cliStatus,
} from './agent-cli/service.ts';
import {
  CHATGPT_MODEL_PATTERN,
  isAssistantEngine,
} from './agent-cli/settings.ts';
import { AGENT_TOOL_INFO, isAgentTool } from './agent-cli/tools.ts';
import {
  type AssistantConfigOptions,
  assistantStatus,
} from './assistant/config.ts';
import {
  chatgptEngineStatus,
  cliEngineStatus,
  cliTool,
} from './assistant/engine.ts';
import { chatgptConnection, openSystemBrowser } from './chatgpt.ts';
import { isDesktopWrapper } from './desktop.ts';
import { guarded, HttpError, json, ownerOf, readJson } from './http.ts';
import { principalFromLocals, requireOwner } from './owner.ts';

type Handler = ReturnType<typeof guarded>;

export interface OnboardingRoutes {
  state: Handler;
  connect: Handler;
  engine: Handler;
  chatgpt: Handler;
  chatgptState: Handler;
  complete: Handler;
  skip: Handler;
}

async function ready(
  engine: AssistantEngineId,
  owner: Parameters<typeof assistantStatus>[0],
  config?: AssistantConfigOptions,
) {
  const tool = cliTool(engine);
  if (tool) return cliEngineStatus(tool, await cliStatus(tool)).configured;
  if (engine === 'chatgpt') return (await chatgptEngineStatus()).configured;
  return (await assistantStatus(owner, config)).configured;
}

export function mountOnboardingRoutes(
  options: {
    config?: AssistantConfigOptions;
    /** Tests: opens the sign-in page. Default: the system browser. */
    openBrowser?: (url: string) => Promise<boolean>;
  } = {},
): OnboardingRoutes {
  const openBrowser = options.openBrowser ?? openSystemBrowser;
  const shared = mountConnectAiRoutes({
    async authorize(event: Parameters<Handler>[0]) {
      const owner = await requireOwner(principalFromLocals(event.locals));
      return {
        engine: () =>
          asSettingsOwner(
            owner,
            async () => (await assistantSettings().read()).engine,
          ),
        select: (engine) =>
          asSettingsOwner(owner, async () => {
            await assistantSettings().write({ engine });
          }),
        cli: { cliStatus, agentLogin },
        chatgpt: await chatgptConnection(),
        apiStatus: () => assistantStatus(owner, options.config),
      };
    },
    openBrowser: (url) =>
      isDesktopWrapper() ? openBrowser(url) : Promise.resolve(false),
    allowUnconfiguredApiSelection: true,
    includeSignOutConfirmation: true,
  });
  const sharedAction = async (
    event: Parameters<Handler>[0],
    body: Record<string, unknown>,
  ) => {
    const response = await shared.POST({
      ...event,
      request: new Request(event.url, {
        method: 'POST',
        headers: {
          origin: event.url.origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    });
    const out = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      if (out.code === 'cli_missing') return { result: 'missing' };
      if (out.code === 'cli_no_answer')
        throw new HttpError(
          502,
          `${AGENT_TOOL_INFO[body.tool as 'codex' | 'claude-code'].label} did not answer. Try again.`,
        );
      if (out.code === 'chatgpt_cancel_unavailable')
        throw new HttpError(
          409,
          'This version cannot cancel the browser sign-in yet. The link expires in ten minutes.',
        );
      if (out.code === 'engine_not_ready')
        throw new HttpError(
          409,
          body.engine === 'chatgpt'
            ? 'Sign in with ChatGPT first.'
            : 'That tool is not ready.',
        );
      throw new HttpError(response.status, 'Could not connect your AI.');
    }
    return out;
  };
  return {
    state: guarded(async (event) => {
      const owner = await ownerOf(event);
      // Use the same preflight-backed, secret-safe status projection as the
      // cookbook host. Shell metadata supplements it, never decides readiness.
      const response = await shared.GET(event);
      if (!response.ok)
        throw new HttpError(response.status, 'Could not check your AI.');
      const state = (await response.json()) as ConnectAiState;
      const [settings, tools, chatgpt] = await Promise.all([
        asSettingsOwner(owner, () => assistantSettings().read()),
        allCliStatus(), // shared.GET just refreshed this inference-owned cache.
        chatgptConnection().then((c) => c.status()),
      ]);
      return json({
        ...state,
        onboarding: settings.onboarding,
        chatgpt,
        tools: state.tools.map((t) => ({
          ...t,
          label: AGENT_TOOL_INFO[t.tool].label,
          version: tools.find((found) => found.tool === t.tool)?.version,
        })),
      });
    }),

    connect: guarded(async (event) => {
      const owner = await ownerOf(event);
      const body = await readJson(event.request);
      if (!isAgentTool(body.tool)) throw new HttpError(400, 'unknown tool');
      const tool = body.tool;
      const out = await sharedAction(event, { action: 'connect', tool });
      if (out.result === 'missing')
        return json({
          result: 'missing',
          installUrl: AGENT_TOOL_INFO[tool].installUrl,
        });
      if (out.ok) return json({ result: 'ready', engine: tool });
      return json({
        result: out.result === 'started' ? 'login_started' : 'login_running',
      });
    }),

    engine: guarded(async (event) => {
      const owner = await ownerOf(event);
      const body = await readJson(event.request);
      if (!isAssistantEngine(body.engine))
        throw new HttpError(400, 'unknown engine');
      await sharedAction(event, { action: 'select', engine: body.engine });
      return json({ engine: body.engine });
    }),

    chatgptState: guarded(async (event) => {
      const owner = await ownerOf(event);
      const connection = await chatgptConnection();
      const [status, settings] = await Promise.all([
        connection.status(),
        asSettingsOwner(owner, () => assistantSettings().read()),
      ]);
      // The model list is a call to OpenAI: only for a signed-in account.
      let models: { id: string; label: string }[] | undefined;
      if (status.signedIn) {
        try {
          models = await connection.models();
        } catch {
          models = undefined; // the page says the list is unavailable
        }
      }
      return json({
        chatgpt: status,
        model: settings.chatgptModel,
        ...(models ? { models } : {}),
      });
    }),

    chatgpt: guarded(async (event) => {
      const owner = await ownerOf(event);
      const body = await readJson(event.request);
      const connection = await chatgptConnection();
      if (body.action === 'start') {
        const out = await sharedAction(event, { action: 'chatgpt-start' });
        return json({ result: 'login_started', ...out });
      }
      if (body.action === 'cancel') {
        return json(await sharedAction(event, { action: 'chatgpt-cancel' }));
      }
      if (body.action === 'sign-out') {
        const out = await sharedAction(event, { action: 'chatgpt-sign-out' });
        const settings = await asSettingsOwner(owner, () =>
          assistantSettings().read(),
        );
        // Signed out of the plan: the engine falls back to nothing chosen.
        if (settings.engine === 'chatgpt')
          await asSettingsOwner(owner, () =>
            assistantSettings().write({ engine: 'api' }),
          );
        return json({
          result: 'signed_out',
          remoteRevocationConfirmed: out.remoteRevocationConfirmed,
        });
      }
      if (body.action === 'model') {
        const model = typeof body.model === 'string' ? body.model : '';
        if (model && !CHATGPT_MODEL_PATTERN.test(model))
          throw new HttpError(400, 'unknown model');
        if (model) {
          const known = await connection.models().catch(() => []);
          if (!known.some((m) => m.id === model))
            throw new HttpError(400, 'unknown model');
        }
        await asSettingsOwner(owner, () =>
          assistantSettings().write({ chatgptModel: model || undefined }),
        );
        return json({ model: model || null });
      }
      throw new HttpError(400, 'unknown action');
    }),

    complete: guarded(async (event) => {
      const owner = await ownerOf(event);
      const body = await readJson(event.request);
      if (body.start === 'wizard')
        throw new HttpError(400, 'The project wizard is coming soon.');
      if (body.start !== 'fresh') throw new HttpError(400, 'unknown start');
      const settings = await asSettingsOwner(owner, () =>
        assistantSettings().read(),
      );
      if (!(await ready(settings.engine, owner, options.config)))
        throw new HttpError(409, 'Connect your AI first.');
      await asSettingsOwner(owner, () =>
        assistantSettings().write({ onboarding: 'fresh' }),
      );
      return json({ onboarding: 'fresh' });
    }),

    skip: guarded(async (event) => {
      const owner = await ownerOf(event);
      await asSettingsOwner(owner, () =>
        assistantSettings().write({ onboarding: 'skipped' }),
      );
      return json({ onboarding: 'skipped' });
    }),
  };
}

export const onboardingRoutes = mountOnboardingRoutes();
