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
import { join } from 'node:path';
import {
  type ChatGPTPlanConnection,
  createChatGPTPlanConnection,
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

export {
  browserCommand,
  type ChatGPTFailureNote,
  openSystemBrowser,
  type SpawnLike,
} from '@happyvertical/smrt-inference/server';

import { chatgptFailureNote as failureNote } from '@happyvertical/smrt-inference/server';
export const chatgptFailureNote = (error: unknown) =>
  failureNote(error, CHATGPT_SETTINGS_HREF);
