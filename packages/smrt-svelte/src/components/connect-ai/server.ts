/** Server-only, framework-neutral mounts over inference's status and vendor sign-in APIs. */
import {
  AGENT_TOOL_INFO,
  AGENT_TOOLS,
  type ChatGPTPlanConnection,
  type createAgentCliService,
  type InferenceEngineId,
  type InferenceEngineStatus,
  inferenceEngineStatus,
  isAgentTool,
  isChatGPTAuthorizationUrl,
} from '@happyvertical/smrt-inference/server';
import type { ConnectAiState } from './types.js';

/** Authenticated bindings: the host must verify owner, tenant and settings authority first. */
export interface ConnectAiServerBinding {
  engine(): Promise<InferenceEngineId | null>;
  select(engine: InferenceEngineId): Promise<void>;
  cli: Pick<
    ReturnType<typeof createAgentCliService>,
    'cliStatus' | 'agentLogin'
  >;
  chatgpt: Pick<ChatGPTPlanConnection, 'status' | 'start' | 'signOut'>;
  /** Resolve the current user's API binding through inference. Never return a key. */
  apiStatus(): Promise<InferenceEngineStatus>;
}

/** Fetch-style request event, structurally compatible with SvelteKit. */
export interface ConnectAiRequestEvent {
  request: Request;
  url: URL;
}

/**
 * Mount GET status and POST actions at one host-owned route. authorize is required
 * and runs on EVERY request, including polls. No process-wide user bindings are cached.
 */
export function mountConnectAiRoutes<E extends ConnectAiRequestEvent>(options: {
  authorize(event: E): Promise<ConnectAiServerBinding | null>;
  /** Desktop hosts may open the validated URL. Otherwise return a new-tab link. */
  openBrowser?(url: string): Promise<boolean>;
  /** Compatibility for hosts that let an API engine remain selected without a key. */
  allowUnconfiguredApiSelection?: boolean;
  /** Include inference's non-secret remote revocation confirmation for existing host routes. */
  includeSignOutConfirmation?: boolean;
}) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
  const error = (status: number, code: string) => json({ code }, status);
  const known = (value: unknown): value is InferenceEngineId =>
    value === 'api' || value === 'chatgpt' || isAgentTool(value);
  const state = async (
    binding: ConnectAiServerBinding,
  ): Promise<ConnectAiState> => {
    const [engine, tools, chatgpt, api] = await Promise.all([
      binding.engine(),
      Promise.all(
        AGENT_TOOLS.map(async (tool) => {
          const found = await binding.cli.cliStatus(tool, { fresh: true });
          return {
            tool,
            installUrl: AGENT_TOOL_INFO[tool].installUrl,
            installed: found.installed,
            signedIn: found.signedIn,
            ...(found.ready !== undefined ? { ready: found.ready } : {}),
            ...(found.startError ? { startError: found.startError } : {}),
            login: binding.cli.agentLogin().snapshot(tool).state,
          };
        }),
      ),
      binding.chatgpt.status(),
      binding.apiStatus(),
    ]);
    const status =
      engine && known(engine)
        ? await inferenceEngineStatus(engine, {
            cliStatus: async (tool) =>
              tools.find((found) => found.tool === tool)!,
            chatgpt: { status: async () => chatgpt },
            apiStatus: async () => api,
          })
        : undefined;
    // Explicit projection: never spread host settings, account details or SDK errors.
    return {
      engine: known(engine) ? engine : null,
      configured: status?.configured === true,
      tools,
      chatgpt: {
        signedIn: chatgpt.signedIn,
        signingIn: chatgpt.signingIn,
        ...(chatgpt.error ? { error: { code: chatgpt.error.code } } : {}),
      },
      apiReady: api.configured,
    };
  };
  return {
    async GET(event: E): Promise<Response> {
      if (event.request.method !== 'GET')
        return error(405, 'method_not_allowed');
      try {
        const binding = await options.authorize(event);
        if (!binding) return error(403, 'not_allowed');
        return json(await state(binding));
      } catch {
        return error(503, 'connect_ai_unavailable');
      }
    },
    async POST(event: E): Promise<Response> {
      if (event.request.method !== 'POST')
        return error(405, 'method_not_allowed');
      if (
        event.request.headers.get('origin') !== event.url.origin ||
        new URL(event.request.url).origin !== event.url.origin
      )
        return error(403, 'invalid_origin');
      if (
        event.request.headers
          .get('content-type')
          ?.split(';')[0]
          .trim()
          .toLowerCase() !== 'application/json'
      )
        return error(415, 'invalid_content_type');
      try {
        const binding = await options.authorize(event);
        if (!binding) return error(403, 'not_allowed');
        const reader = event.request.body?.getReader();
        if (!reader) return error(400, 'invalid_request');
        let bytes = new Uint8Array(0);
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            if (bytes.length + part.value.length > 1024) {
              await reader.cancel();
              return error(413, 'request_too_large');
            }
            const next = new Uint8Array(bytes.length + part.value.length);
            next.set(bytes);
            next.set(part.value, bytes.length);
            bytes = next;
          }
        } finally {
          reader.releaseLock();
        }
        let body: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return error(400, 'invalid_request');
          body = parsed as Record<string, unknown>;
        } catch {
          return error(400, 'invalid_request');
        }
        if (body.action === 'select') {
          if (!known(body.engine)) return error(400, 'unknown_engine');
          const ready = await inferenceEngineStatus(body.engine, {
            cliStatus: (tool) => binding.cli.cliStatus(tool, { fresh: true }),
            chatgpt: binding.chatgpt,
            apiStatus: () => binding.apiStatus(),
          });
          if (
            !ready.configured &&
            !(body.engine === 'api' && options.allowUnconfiguredApiSelection)
          )
            return error(409, 'engine_not_ready');
          await binding.select(body.engine);
          return json({ ok: true });
        }
        if (body.action === 'connect') {
          if (!isAgentTool(body.tool)) return error(400, 'unknown_tool');
          const found = await binding.cli.cliStatus(body.tool, { fresh: true });
          if (!found.installed) return error(409, 'cli_missing');
          if (found.signedIn === null) return error(502, 'cli_no_answer');
          if (found.ready === false) return error(409, 'engine_not_ready');
          if (found.signedIn) {
            await binding.select(body.tool);
            return json({ ok: true });
          }
          const result = await binding.cli.agentLogin().start(body.tool);
          return json({ result });
        }
        if (body.action === 'chatgpt-start') {
          const { authorizationUrl } = await binding.chatgpt.start();
          if (!isChatGPTAuthorizationUrl(authorizationUrl))
            return error(502, 'invalid_authorization_url');
          const opened =
            (await options.openBrowser?.(authorizationUrl)) ?? false;
          return json(opened ? { opened } : { opened, authorizationUrl });
        }
        if (body.action === 'chatgpt-sign-out') {
          const out = await binding.chatgpt.signOut();
          return json({
            ok: true,
            ...(options.includeSignOutConfirmation
              ? { remoteRevocationConfirmed: out.remoteRevocationConfirmed }
              : {}),
          });
        }
        return error(400, 'unknown_action');
      } catch {
        return error(503, 'connect_ai_unavailable');
      }
    },
  };
}
