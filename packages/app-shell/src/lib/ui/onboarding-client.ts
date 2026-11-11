// Browser side of onboarding: the typed calls and the pure decisions the
// Connect panel and the Welcome page make from them. No credential is ever
// handled here; "connect" asks the server to use the CLI already on this
// computer (see lib/server/agent-cli/tools.ts for the rule).

import type { AssistantEngineId } from '../assistant/events.ts';
import { targetPath } from './target.ts';

export interface ToolInfo {
  tool: 'claude-code' | 'codex';
  label: string;
  installed: boolean;
  version?: string;
  /** `null`: the tool did not answer. */
  signedIn: boolean | null;
  installUrl: string;
  login: 'idle' | 'running' | 'finished' | 'failed';
}

/** Sign in with ChatGPT, as the server reports it. Never a token. */
export interface ChatGPTInfo {
  signedIn: boolean;
  signingIn: boolean;
  account?: { label: string };
  error?: {
    code: NonNullable<
      import('@happyvertical/smrt-svelte/connect-ai').ConnectAiState['chatgpt']['error']
    >['code'];
    message: string;
  };
}

export interface OnboardingInfo {
  onboarding: 'fresh' | 'skipped' | null;
  engine: AssistantEngineId;
  apiReady: boolean;
  /** Absent from an older server: treated as not signed in. */
  chatgpt?: ChatGPTInfo;
  tools: ToolInfo[];
}

type Fetch = typeof fetch;

export class OnboardingError extends Error {}

async function call<T>(
  path: string,
  init: RequestInit | undefined,
  doFetch: Fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await doFetch(targetPath(path, 'live'), init);
  } catch {
    throw new OnboardingError('Could not reach the app.');
  }
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok)
    throw new OnboardingError(
      body?.error ?? `Request failed (${response.status}).`,
    );
  return body as T;
}

const post = (path: string, body: unknown, doFetch: Fetch) =>
  call<Record<string, unknown>>(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    doFetch,
  );

export const fetchOnboarding = (fresh = false, doFetch: Fetch = fetch) =>
  call<OnboardingInfo>(
    `/api/shell/onboarding${fresh ? '?fresh=1' : ''}`,
    undefined,
    doFetch,
  );

export type ConnectResult =
  | { result: 'ready'; engine: AssistantEngineId }
  | { result: 'login_started' | 'login_running' }
  | { result: 'missing'; installUrl: string };

export const connectTool = (tool: ToolInfo['tool'], doFetch: Fetch = fetch) =>
  post(
    '/api/shell/onboarding/connect',
    { tool },
    doFetch,
  ) as Promise<ConnectResult>;

export type ChatGPTStart = {
  result: 'login_started';
  /** The app opened the system browser itself (desktop). */
  opened: boolean;
  /** Set when the page must open it: a normal new-tab link. */
  authorizationUrl?: string;
};

export const startChatGPT = (doFetch: Fetch = fetch) =>
  post(
    '/api/shell/onboarding/chatgpt',
    { action: 'start' },
    doFetch,
  ) as Promise<ChatGPTStart>;

export const signOutChatGPT = (doFetch: Fetch = fetch) =>
  post('/api/shell/onboarding/chatgpt', { action: 'sign-out' }, doFetch);

export interface ChatGPTState {
  chatgpt: ChatGPTInfo;
  model: string | null;
  models?: { id: string; label: string }[];
}

export const fetchChatGPT = (doFetch: Fetch = fetch) =>
  call<ChatGPTState>('/api/shell/onboarding/chatgpt', undefined, doFetch);

export const chooseChatGPTModel = (
  model: string | null,
  doFetch: Fetch = fetch,
) =>
  post(
    '/api/shell/onboarding/chatgpt',
    { action: 'model', model: model ?? '' },
    doFetch,
  );

export const chooseEngine = (
  engine: AssistantEngineId,
  doFetch: Fetch = fetch,
) => post('/api/shell/onboarding/engine', { engine }, doFetch);

export const completeFresh = (doFetch: Fetch = fetch) =>
  post('/api/shell/onboarding/complete', { start: 'fresh' }, doFetch);

export const skipOnboarding = (doFetch: Fetch = fetch) =>
  post('/api/shell/onboarding/skip', {}, doFetch);

// Shared connection presentation; routes below remain the shell's host policy.
export {
  apiRow,
  chatgptAction,
  chatgptDescription,
  engineReady,
  toolAction,
  visibleTools,
} from '@happyvertical/smrt-svelte/connect-ai/client';

/** Pages the first-run welcome never interrupts. */
const NO_WELCOME = /^\/(welcome|settings|setup|sign-out|approvals)(\/|$)/;

/**
 * Whether an owner landing on `pathname` is sent to the welcome steps: only
 * with an empty app (no models yet) and onboarding neither finished nor
 * skipped. An app already in use is never interrupted.
 */
export function needsWelcome(input: {
  pathname: string;
  modelCount: number;
  onboarding: 'fresh' | 'skipped' | null;
}): boolean {
  return (
    input.onboarding === null &&
    input.modelCount === 0 &&
    !NO_WELCOME.test(input.pathname)
  );
}

/** Existing shell route DTOs adapted to the shared, provider-free connection component. */
export function createShellConnectAiClient(options: {
  onchange?: (info: OnboardingInfo, ready: boolean) => void;
}): import('@happyvertical/smrt-svelte/connect-ai').ConnectAiClient {
  const boundFetch =
    (signal?: AbortSignal): Fetch =>
    (input, init) =>
      fetch(input, { ...init, signal });
  return {
    async state(signal) {
      const info = await fetchOnboarding(true, boundFetch(signal));
      const { engineReady } = await import(
        '@happyvertical/smrt-svelte/connect-ai/client'
      );
      const configured = engineReady(info);
      options.onchange?.(info, configured);
      return {
        ...info,
        configured,
        chatgpt: info.chatgpt ?? { signedIn: false, signingIn: false },
      };
    },
    async connect(tool, signal) {
      await connectTool(tool, boundFetch(signal));
    },
    connectOutcome: (tool, signal) => connectTool(tool, boundFetch(signal)),
    async choose(engine, signal) {
      await chooseEngine(engine, boundFetch(signal));
    },
    startChatGPT: (signal) => startChatGPT(boundFetch(signal)),
    errorMessage: (error) =>
      error instanceof OnboardingError
        ? error.message
        : 'Something went wrong.',
    async signOutChatGPT(signal) {
      await signOutChatGPT(boundFetch(signal));
    },
    modelState: (signal) => fetchChatGPT(boundFetch(signal)),
    async chooseModel(model, signal) {
      await chooseChatGPTModel(model, boundFetch(signal));
    },
  };
}
