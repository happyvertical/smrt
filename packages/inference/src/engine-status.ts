import type { AgentCliStatus } from './agent-cli/detect.js';
import { AGENT_TOOL_INFO, type AgentTool } from './agent-cli/tools.js';
import type { ChatGPTPlanConnection } from './chatgpt/connection.js';
import { engineLabel, type InferenceEngineId } from './engine-id.js';

export { engineLabel, type InferenceEngineId } from './engine-id.js';
export interface InferenceEngineAction {
  label: string;
  href: string;
}
export interface InferenceEngineStatus {
  configured: boolean;
  engine?: InferenceEngineId;
  engineLabel?: string;
  code?: string;
  startError?: AgentCliStatus['startError'];
  message?: string;
  action?: InferenceEngineAction;
}

export function cliTool(engine: InferenceEngineId): AgentTool | null {
  return engine === 'claude-code' || engine === 'codex' ? engine : null;
}

/** Status of the ChatGPT engine from the connection (no network call). */
export async function chatgptEngineStatus(
  connection: Pick<ChatGPTPlanConnection, 'status'>,
  action?: InferenceEngineAction,
): Promise<InferenceEngineStatus> {
  const base = { engine: 'chatgpt', engineLabel: 'ChatGPT' } as const;
  const status = await connection.status();
  if (status.signedIn) return { ...base, configured: true };
  return {
    ...base,
    configured: false,
    code: 'chatgpt_signed_out',
    message: 'ChatGPT is not signed in.',
    ...(action ? { action } : {}),
  };
}

/** Status of a CLI engine from what the tool itself reported. */
export function cliEngineStatus(
  tool: AgentTool,
  found: Pick<
    AgentCliStatus,
    'installed' | 'signedIn' | 'ready' | 'startError'
  >,
  action?: InferenceEngineAction,
): InferenceEngineStatus {
  const label = AGENT_TOOL_INFO[tool].label;
  const base = { engine: tool, engineLabel: label } as const;
  if (!found.installed)
    return {
      ...base,
      configured: false,
      code: 'agent_cli_missing',
      message: `${label} is not installed on this computer.`,
      ...(action ? { action } : {}),
    };
  if (found.signedIn !== true)
    return {
      ...base,
      configured: false,
      code: 'agent_cli_signed_out',
      message: `${label} is not signed in.`,
      ...(action ? { action } : {}),
    };
  if (found.ready !== true)
    return {
      ...base,
      configured: false,
      code: 'agent_cli_startup',
      ...(found.startError ? { startError: found.startError } : {}),
      message:
        found.startError === 'tool_host_policy'
          ? `${label} cannot start the app tool host with this Codex version. Update Codex, then check again in AI settings.`
          : found.startError === 'working_directory'
            ? `${label} needs a writable temporary directory.`
            : found.startError === 'runtime_unavailable'
              ? `${label} cannot start in this app's process environment. Check its executable and Node installation.`
              : `${label} does not accept the required locked-down invocation. Update the CLI, then retry.`,
      ...(action ? { action } : {}),
    };
  return { ...base, configured: true };
}

/** The selected engine is the only connection this dispatcher consults. */
export interface InferenceEngineStatusHost {
  cliStatus(
    tool: AgentTool,
  ): Promise<
    Pick<AgentCliStatus, 'installed' | 'signedIn' | 'ready' | 'startError'>
  >;
  chatgpt: Pick<ChatGPTPlanConnection, 'status'>;
  apiStatus(): Promise<InferenceEngineStatus>;
  actions?: {
    cli?: InferenceEngineAction;
    chatgpt?: InferenceEngineAction;
    api?: InferenceEngineAction;
  };
}

/** Host supplies API-key resolution, CLI detection and settings destinations. */
export async function inferenceEngineStatus(
  engine: InferenceEngineId,
  host: InferenceEngineStatusHost,
): Promise<InferenceEngineStatus> {
  const tool = cliTool(engine);
  if (tool)
    return cliEngineStatus(tool, await host.cliStatus(tool), host.actions?.cli);
  if (engine === 'chatgpt')
    return chatgptEngineStatus(host.chatgpt, host.actions?.chatgpt);
  const api = await host.apiStatus();
  return {
    ...api,
    engine: 'api',
    engineLabel: engineLabel('api'),
    ...(!api.configured && host.actions?.api
      ? { action: host.actions.api }
      : {}),
  };
}
