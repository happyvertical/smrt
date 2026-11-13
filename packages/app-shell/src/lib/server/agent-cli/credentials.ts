// The shell owns token identity and permissions; inference owns the lifecycle.
import {
  tokenCredentials as createCredentials,
  type McpTokenStoreLike,
} from '@happyvertical/smrt-inference/server';
import { ASSISTANT_USE_PERMISSION } from './settings.ts';

export {
  AGENT_TOKEN_TTL_SECONDS,
  type AgentCredentials,
  type McpTokenStoreLike,
} from '@happyvertical/smrt-inference/server';
export const AGENT_TOKEN_HOLDER = 'shell-assistant';
export function tokenCredentials(
  store: () => Promise<McpTokenStoreLike | undefined>,
) {
  return createCredentials(store, {
    holder: AGENT_TOKEN_HOLDER,
    label: 'Shell assistant',
    scopes: [ASSISTANT_USE_PERMISSION],
  });
}
