// Which engine runs the assistant, and whether it can run right now.
//
//   api          an API key through smrt-inference's tiers (config.ts)
//   claude-code  the person's own Claude Code, signed in (agent-turn.ts)
//   codex        the person's own Codex CLI, signed in (agent-turn.ts)
//   chatgpt      the owner's own ChatGPT plan, Sign in with ChatGPT (model.ts)
//
// The choice is the non-secret `assistant` preference (agent-cli/settings.ts).
import type {
  AssistantEngineId,
  AssistantStatus,
} from '../../assistant/events.ts';
import type { AgentCliStatus } from '../agent-cli/detect.ts';
import type { AgentTool } from '../agent-cli/tools.ts';
import { CHATGPT_SETTINGS_HREF, chatgptConnection } from '../chatgpt.ts';
import type { Principal } from '../owner.ts';
import { type AssistantConfigOptions, assistantStatus } from './config.ts';

export const SETUP_ACTION = { label: 'Set up the assistant', href: '/welcome' };

export { cliTool, engineLabel } from '@happyvertical/smrt-inference/server';

import {
  chatgptEngineStatus as chatgptStatusView,
  cliEngineStatus as cliStatusView,
  inferenceEngineStatus,
} from '@happyvertical/smrt-inference/server';
export const cliEngineStatus = (
  tool: AgentTool,
  found: Pick<AgentCliStatus, 'installed' | 'signedIn'>,
): AssistantStatus => cliStatusView(tool, found, SETUP_ACTION);
export const chatgptEngineStatus = async (): Promise<AssistantStatus> =>
  chatgptStatusView(await chatgptConnection(), {
    label: 'Sign in with ChatGPT',
    href: CHATGPT_SETTINGS_HREF,
  });
export async function statusFor(
  engine: AssistantEngineId,
  principal: Principal,
  options: {
    config: AssistantConfigOptions;
    cliStatus(tool: AgentTool): Promise<AgentCliStatus>;
  },
): Promise<AssistantStatus> {
  return inferenceEngineStatus(engine, {
    cliStatus: options.cliStatus,
    chatgpt: { status: async () => (await chatgptConnection()).status() },
    apiStatus: () => assistantStatus(principal, options.config),
    actions: {
      cli: SETUP_ACTION,
      chatgpt: { label: 'Sign in with ChatGPT', href: CHATGPT_SETTINGS_HREF },
      api: { label: 'Open Inference settings', href: '/settings/inference' },
    },
  });
}
