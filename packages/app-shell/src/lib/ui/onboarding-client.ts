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
  error?: { code: string; message: string };
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

/** Whether the engine in effect can answer right now. */
export function engineReady(info: OnboardingInfo): boolean {
  if (info.engine === 'api') return info.apiReady;
  if (info.engine === 'chatgpt') return info.chatgpt?.signedIn === true;
  const tool = info.tools.find((t) => t.tool === info.engine);
  return !!tool?.installed && tool.signedIn === true;
}

/**
 * The API-key line under the tools: "in-use" only when the API engine is the
 * one in effect AND a key resolves; "available" when a key resolves but
 * another engine is chosen (or the chosen one is not working); "none" when
 * nothing works yet. Covers every engine: with `chatgpt` chosen and signed in,
 * the API key is "available", never "in use".
 */
export function apiRow(info: OnboardingInfo): 'in-use' | 'available' | 'none' {
  if (!info.apiReady) return 'none';
  return info.engine === 'api' ? 'in-use' : 'available';
}

/**
 * Which tools each page lists. The welcome step offers Claude Code (and the
 * ChatGPT row); Codex is an advanced option that lives under Settings >
 * Assistant only.
 */
export function visibleTools(
  info: OnboardingInfo,
  variant: 'welcome' | 'settings',
): { main: ToolInfo[]; advanced: ToolInfo[] } {
  if (variant === 'settings')
    return {
      main: info.tools.filter((t) => t.tool !== 'codex'),
      advanced: info.tools.filter((t) => t.tool === 'codex'),
    };
  return { main: info.tools.filter((t) => t.tool !== 'codex'), advanced: [] };
}

export type ChatGPTAction =
  | { kind: 'in-use'; label: string }
  | { kind: 'use'; label: string }
  | { kind: 'sign-in'; label: string }
  | { kind: 'waiting'; label: string };

/** The one button the ChatGPT row gets, and its words. */
export function chatgptAction(info: OnboardingInfo): ChatGPTAction {
  const chatgpt = info.chatgpt;
  if (chatgpt?.signedIn)
    return info.engine === 'chatgpt'
      ? { kind: 'in-use', label: 'In use' }
      : { kind: 'use', label: 'Use ChatGPT' };
  if (chatgpt?.signingIn)
    return { kind: 'waiting', label: 'Waiting for sign-in…' };
  return { kind: 'sign-in', label: 'Sign in with ChatGPT' };
}

/** The line under the ChatGPT row's name. */
export function chatgptDescription(info: OnboardingInfo): string {
  const chatgpt = info.chatgpt;
  if (chatgpt?.signedIn)
    return `Signed in${chatgpt.account ? ` as ${chatgpt.account.label}` : ''}.`;
  if (chatgpt?.signingIn) return 'Finish signing in in your browser.';
  if (chatgpt?.error) return chatgpt.error.message;
  return 'Use your own ChatGPT plan. A preview for open source apps.';
}

export type ToolAction =
  | { kind: 'in-use'; label: string }
  | { kind: 'use'; label: string }
  | { kind: 'sign-in'; label: string }
  | { kind: 'waiting'; label: string }
  | { kind: 'install'; label: string }
  | { kind: 'retry'; label: string };

/** The one button a tool gets, and its words. */
export function toolAction(tool: ToolInfo, info: OnboardingInfo): ToolAction {
  if (!tool.installed) return { kind: 'install', label: 'How to install' };
  if (tool.signedIn === null) return { kind: 'retry', label: 'Check again' };
  if (tool.signedIn === false)
    return tool.login === 'running'
      ? { kind: 'waiting', label: 'Waiting for sign-in…' }
      : { kind: 'sign-in', label: `Sign in with ${tool.label}` };
  return info.engine === tool.tool
    ? { kind: 'in-use', label: 'In use' }
    : { kind: 'use', label: `Use ${tool.label}` };
}

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
