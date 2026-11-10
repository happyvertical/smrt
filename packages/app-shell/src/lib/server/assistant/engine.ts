// Which engine runs the assistant, and whether it can run right now.
//
//   api          an API key through smrt-inference's tiers (config.ts)
//   claude-code  the person's own Claude Code, signed in (agent-turn.ts)
//   codex        the person's own Codex CLI, signed in (agent-turn.ts)
//
// The choice is the non-secret `assistant` preference (agent-cli/settings.ts).
import type {
  AssistantEngineId,
  AssistantStatus,
} from '../../assistant/events.ts';
import type { AgentCliStatus } from '../agent-cli/detect.ts';
import { AGENT_TOOL_INFO, type AgentTool } from '../agent-cli/tools.ts';
import type { Principal } from '../owner.ts';
import { type AssistantConfigOptions, assistantStatus } from './config.ts';

export const SETUP_ACTION = { label: 'Set up the assistant', href: '/welcome' };

export function cliTool(engine: AssistantEngineId): AgentTool | null {
  return engine === 'claude-code' || engine === 'codex' ? engine : null;
}

export function engineLabel(engine: AssistantEngineId): string {
  const tool = cliTool(engine);
  return tool ? AGENT_TOOL_INFO[tool].label : 'your API key';
}

/** Status of a CLI engine from what the tool itself reported. */
export function cliEngineStatus(
  tool: AgentTool,
  found: Pick<AgentCliStatus, 'installed' | 'signedIn'>,
): AssistantStatus {
  const label = AGENT_TOOL_INFO[tool].label;
  const base = { engine: tool, engineLabel: label } as const;
  if (!found.installed)
    return {
      ...base,
      configured: false,
      code: 'agent_cli_missing',
      message: `${label} is not installed on this computer.`,
      action: SETUP_ACTION,
    };
  if (found.signedIn !== true)
    return {
      ...base,
      configured: false,
      code: 'agent_cli_signed_out',
      message: `${label} is not signed in.`,
      action: SETUP_ACTION,
    };
  return { ...base, configured: true };
}

export async function statusFor(
  engine: AssistantEngineId,
  principal: Principal,
  options: {
    config: AssistantConfigOptions;
    cliStatus(tool: AgentTool): Promise<AgentCliStatus>;
  },
): Promise<AssistantStatus> {
  const tool = cliTool(engine);
  if (tool) return cliEngineStatus(tool, await options.cliStatus(tool));
  const api = await assistantStatus(principal, options.config);
  return {
    ...api,
    engine: 'api',
    engineLabel: engineLabel('api'),
    ...(api.configured
      ? {}
      : {
          action: {
            label: 'Open Inference settings',
            href: '/settings/inference',
          },
        }),
  };
}
