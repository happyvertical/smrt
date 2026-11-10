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
  invalidateCliStatus,
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
  return {
    state: guarded(async (event) => {
      const owner = await ownerOf(event);
      const fresh = event.url.searchParams.get('fresh') === '1';
      const login = agentLogin();
      const [settings, tools, api, chatgpt] = await Promise.all([
        asSettingsOwner(owner, () => assistantSettings().read()),
        allCliStatus({ fresh }),
        assistantStatus(owner, options.config),
        chatgptConnection().then((c) => c.status()),
      ]);
      return json({
        onboarding: settings.onboarding,
        engine: settings.engine,
        apiReady: api.configured,
        chatgpt,
        tools: tools.map((t) => ({
          ...t,
          login: login.snapshot(t.tool).state,
        })),
      });
    }),

    connect: guarded(async (event) => {
      const owner = await ownerOf(event);
      const body = await readJson(event.request);
      if (!isAgentTool(body.tool)) throw new HttpError(400, 'unknown tool');
      const tool = body.tool;
      const status = await cliStatus(tool, { fresh: true });
      if (!status.installed)
        return json({
          result: 'missing',
          installUrl: AGENT_TOOL_INFO[tool].installUrl,
        });
      if (status.signedIn === true) {
        await asSettingsOwner(owner, () =>
          assistantSettings().write({ engine: tool }),
        );
        return json({ result: 'ready', engine: tool });
      }
      if (status.signedIn === null)
        throw new HttpError(
          502,
          `${AGENT_TOOL_INFO[tool].label} did not answer. Try again.`,
        );
      const started = await agentLogin().start(tool);
      return json({
        result: started === 'started' ? 'login_started' : 'login_running',
      });
    }),

    engine: guarded(async (event) => {
      const owner = await ownerOf(event);
      const body = await readJson(event.request);
      if (!isAssistantEngine(body.engine))
        throw new HttpError(400, 'unknown engine');
      if (body.engine === 'chatgpt') {
        const found = await chatgptEngineStatus();
        if (!found.configured)
          throw new HttpError(409, 'Sign in with ChatGPT first.');
      }
      const tool = cliTool(body.engine);
      if (tool) {
        invalidateCliStatus(tool);
        const found = cliEngineStatus(
          tool,
          await cliStatus(tool, { fresh: true }),
        );
        if (!found.configured)
          throw new HttpError(409, found.message ?? 'That tool is not ready.');
      }
      await asSettingsOwner(owner, () =>
        assistantSettings().write({ engine: body.engine as AssistantEngineId }),
      );
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
        const { authorizationUrl } = await connection.start();
        // The desktop wrapper has no browser to hand a link to: open the
        // system browser from here (https on OpenAI's host only). A plain
        // browser session gets the address for a normal link instead.
        const opened = isDesktopWrapper()
          ? await openBrowser(authorizationUrl)
          : false;
        return json({
          result: 'login_started',
          opened,
          ...(opened ? {} : { authorizationUrl }),
        });
      }
      if (body.action === 'sign-out') {
        const out = await connection.signOut();
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
