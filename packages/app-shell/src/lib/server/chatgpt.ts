// Sign in with ChatGPT, the shell's side: the one connection (smrt-inference's
// service over the SDK's local session manager), the system-browser opener, and
// the words for each way the plan can refuse.
//
// OpenAI's flow for local open source apps, a PREVIEW:
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
//
// The SDK keeps the credentials in one owner-only file under the app's data
// root (`<data root>/chatgpt/chatgpt.json`). Nothing here reads that file or
// holds a token: the connection answers "signed in?" and an account label, and
// hands the provider a token handle. Not offered for Claude: its subscription
// stays on the Claude Code engine (`claude-cli` is refused, config.ts).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  type ChatGPTPlanConnection,
  type ChatGPTPlanFailureKind,
  classifyChatGPTPlanFailure,
  createChatGPTPlanConnection,
  isChatGPTAuthorizationUrl,
} from '@happyvertical/smrt-inference/server';
import { dataRoot } from './host.ts';

/** Where "Sign in again" sends the owner (Settings > Assistant). */
export const CHATGPT_SETTINGS_HREF = '/settings/assistant#chatgpt';

/**
 * The `className` of the assistant's inference request on this engine. The
 * ChatGPT resolver applies to exactly this name: choosing the engine is the
 * only way a call is moved onto the plan.
 */
export const CHATGPT_ASSISTANT_CLASS = 'AppShellAssistantChatGPT';

/** How the shell's tools are described to the model on this provider. */
export const CHATGPT_TOOL_NAMESPACE = {
  name: 'shell_tools',
  description:
    "Tools that read and change the owner's own app, and that ask the owner to approve risky changes.",
} as const;

let connection: Promise<ChatGPTPlanConnection> | undefined;
let override: ChatGPTPlanConnection | undefined;

/** Tests: use this connection instead of the SDK's. Pass undefined to reset. */
export function setChatGPTConnection(next: ChatGPTPlanConnection | undefined) {
  override = next;
  connection = undefined;
}

/** The shell's connection, built on first use under the data root. */
export function chatgptConnection(): Promise<ChatGPTPlanConnection> {
  if (override) return Promise.resolve(override);
  connection ??= dataRoot()
    .then((root) =>
      createChatGPTPlanConnection({
        appName: process.env.SMRT_APP_SHELL_NAME?.trim() || 'smrt app shell',
        credentialsPath: join(root, 'chatgpt', 'chatgpt.json'),
      }),
    )
    .catch((cause: unknown) => {
      connection = undefined;
      throw cause;
    });
  return connection;
}

/** The connection as the resolver sees it: opened only when a call asks. */
export const lazyChatgptConnection: Pick<
  ChatGPTPlanConnection,
  'status' | 'defaultModel'
> = {
  status: async () => (await chatgptConnection()).status(),
  defaultModel: async () => (await chatgptConnection()).defaultModel(),
};

/** The command that opens `url` in the system browser on `platform`. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; verbatim?: boolean } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32')
    // `&` and `%` need the URL quoted for cmd.exe; `""` is start's title.
    return {
      command: 'cmd',
      args: ['/c', 'start', '""', `"${url}"`],
      verbatim: true,
    };
  return { command: 'xdg-open', args: [url] };
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: {
    detached: boolean;
    stdio: 'ignore';
    windowsVerbatimArguments?: boolean;
  },
) => { unref(): void; once(event: 'error', listener: () => void): unknown };

/**
 * Open OpenAI's sign-in page in the system browser from the app process (the
 * desktop wrapper has no browser of its own to hand a link to). Refuses any
 * address that is not https on OpenAI's host, before anything is spawned.
 * Resolves `false` when the opener could not start.
 */
export async function openSystemBrowser(
  url: string,
  deps: { platform?: NodeJS.Platform; spawn?: SpawnLike } = {},
): Promise<boolean> {
  if (!isChatGPTAuthorizationUrl(url))
    throw new Error('Only the ChatGPT sign-in page can be opened.');
  const { command, args, verbatim } = browserCommand(url, deps.platform);
  const run = deps.spawn ?? (spawn as unknown as SpawnLike);
  return new Promise<boolean>((resolve) => {
    try {
      const child = run(command, args, {
        detached: true,
        stdio: 'ignore',
        ...(verbatim ? { windowsVerbatimArguments: true } : {}),
      });
      child.once('error', () => resolve(false));
      child.unref();
      // `open` and friends return at once; an error arrives on the next tick.
      setTimeout(() => resolve(true), 50);
    } catch {
      resolve(false);
    }
  });
}

/** What the dock shows for a plan failure. No provider text, no ids. */
export interface ChatGPTFailureNote {
  code: string;
  message: string;
  action?: { label: string; href: string };
}

const SIGN_IN_AGAIN = { label: 'Sign in again', href: CHATGPT_SETTINGS_HREF };

const NOTES: Record<
  Exclude<ChatGPTPlanFailureKind, 'other'>,
  ChatGPTFailureNote
> = {
  usage_limit: {
    code: 'chatgpt_usage_limit',
    message:
      'Your ChatGPT plan has reached its usage limit. Try again later, or check ChatGPT Settings, Usage.',
  },
  session_revoked: {
    code: 'chatgpt_session_revoked',
    message:
      'Your ChatGPT sign-in is no longer valid. Sign in again to keep using the assistant.',
    action: SIGN_IN_AGAIN,
  },
  workspace: {
    code: 'chatgpt_workspace',
    message:
      'This ChatGPT account or workspace is not allowed to be used here. Sign in with another account.',
    action: SIGN_IN_AGAIN,
  },
  unavailable: {
    code: 'chatgpt_unavailable',
    message:
      'ChatGPT plan use is not available right now. You are still signed in. Try again in a moment.',
  },
  unsupported_capability: {
    code: 'chatgpt_unsupported',
    message:
      'The assistant sent something ChatGPT plan use does not allow, so nothing was done. This is a fault in the app, not your account.',
  },
};

/** The dock note for a ChatGPT plan failure, else `undefined` (not one). */
export function chatgptFailureNote(
  error: unknown,
): ChatGPTFailureNote | undefined {
  const kind = classifyChatGPTPlanFailure(error);
  return kind === 'other' ? undefined : NOTES[kind];
}
