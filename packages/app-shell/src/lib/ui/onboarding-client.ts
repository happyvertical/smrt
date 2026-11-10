// Browser side of onboarding: the typed calls and the pure decisions the
// Connect panel and the Welcome page make from them. No credential is ever
// handled here; "connect" asks the server to use the CLI already on this
// computer (see lib/server/agent-cli/tools.ts for the rule).
import type { AssistantEngineId } from '../assistant/events.ts';

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

export interface OnboardingInfo {
  onboarding: 'fresh' | 'skipped' | null;
  engine: AssistantEngineId;
  apiReady: boolean;
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
    response = await doFetch(path, init);
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
  const tool = info.tools.find((t) => t.tool === info.engine);
  return !!tool?.installed && tool.signedIn === true;
}

/**
 * The API-key line under the tools: "in-use" only when the API engine is the
 * one in effect AND a key resolves; "available" when a key resolves but
 * another engine is chosen; "none" when nothing works yet.
 */
export function apiRow(info: OnboardingInfo): 'in-use' | 'available' | 'none' {
  if (!info.apiReady) return 'none';
  return info.engine === 'api' ? 'in-use' : 'available';
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
