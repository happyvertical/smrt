import { AGENT_TOOL_INFO, isAgentTool } from './agent-cli/tools.js';

/** Browser-safe engine identity shared by settings and execution adapters. */
export type InferenceEngineId = 'api' | 'chatgpt' | 'claude-code' | 'codex';

/** Plain product names shared by browser settings and server status. */
export function engineLabel(engine: InferenceEngineId): string {
  if (engine === 'chatgpt') return 'ChatGPT';
  return isAgentTool(engine) ? AGENT_TOOL_INFO[engine].label : 'your API key';
}
