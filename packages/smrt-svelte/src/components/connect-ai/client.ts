import type { ConnectAiClient, ConnectAiState } from './types.js';

/** Same-origin JSON transport for mountConnectAiRoutes. It never exposes server error text. */
export function createConnectAiClient(options: {
  endpoint: string;
  fetch?: typeof fetch;
}): ConnectAiClient {
  if (!/^\/(?!\/)[^?#]*$/.test(options.endpoint))
    throw new Error('Connect AI requires a same-origin route path.');
  const doFetch = options.fetch ?? fetch;
  const call = async <T>(
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const response = await doFetch(options.endpoint, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      ...(body
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    });
    if (!response.ok) throw new Error('Connect AI request failed.');
    return response.json() as Promise<T>;
  };
  return {
    state: (signal) => call<ConnectAiState>(undefined, signal),
    connect: async (tool, signal) => {
      await call({ action: 'connect', tool }, signal);
    },
    choose: async (engine, signal) => {
      await call({ action: 'select', engine }, signal);
    },
    startChatGPT: (signal) => call({ action: 'chatgpt-start' }, signal),
    signOutChatGPT: async (signal) => {
      await call({ action: 'chatgpt-sign-out' }, signal);
    },
  };
}

// Presentation decisions shared with compact hosts and saved shell UI tests.
type ToolInfo = ConnectAiState['tools'][number];
type OnboardingInfo = Pick<ConnectAiState, 'engine' | 'apiReady' | 'tools'> & {
  chatgpt?: ConnectAiState['chatgpt'];
};
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
  variant: 'welcome' | 'onboarding' | 'settings',
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
  if (chatgpt?.error?.message) return chatgpt.error.message;
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
      : {
          kind: 'sign-in',
          label: `Sign in with ${tool.label ?? (tool.tool === 'codex' ? 'Codex' : 'Claude Code')}`,
        };
  return info.engine === tool.tool
    ? { kind: 'in-use', label: 'In use' }
    : {
        kind: 'use',
        label: `Use ${tool.label ?? (tool.tool === 'codex' ? 'Codex' : 'Claude Code')}`,
      };
}
