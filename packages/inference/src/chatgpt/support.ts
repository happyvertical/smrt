import { spawn } from 'node:child_process';
import { isChatGPTAuthorizationUrl } from './connection.js';
import {
  type ChatGPTPlanFailureKind,
  classifyChatGPTPlanFailure,
} from './resolver.js';

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
  },
  workspace: {
    code: 'chatgpt_workspace',
    message:
      'This ChatGPT account or workspace is not allowed to be used here. Sign in with another account.',
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
  settingsHref?: string,
): ChatGPTFailureNote | undefined {
  const kind = classifyChatGPTPlanFailure(error);
  if (kind === 'other') return undefined;
  const note = NOTES[kind];
  return {
    ...note,
    ...(settingsHref && (kind === 'session_revoked' || kind === 'workspace')
      ? { action: { label: 'Sign in again', href: settingsHref } }
      : {}),
  };
}
