/**
 * smrt planner as a package: mount `Planner` for the full app shell, or
 * `PlannerControls` inside a host-owned shell,
 * drive it with the typed command set (`./commands` has no UI in it), and read
 * its plan as a compact snapshot.
 *
 * @module
 */

export type {
  BrowserAssistantTransport,
  PlannerConversationSeed,
} from './assistant/transport.ts';
export {
  type AgentPrompt,
  type AgentPromptOptions,
  buildAgentPrompt,
} from './cookbook/prompt.ts';
export {
  type ByoPresetDefinition,
  type ConfigResult,
  type CredentialPersistence,
  type InferenceConfig,
  type InferenceMode,
  loadInferenceConfig,
  parseInferenceConfig,
} from './inference/config.ts';
export {
  createHostChat,
  type HostChatOptions,
  type HostRequest,
} from './inference/host.ts';
export { createOpenAIChat, testConnection } from './inference/openai.ts';
export {
  type KitchenConfig,
  type KitchenEndpoint,
  type KitchenOutcome,
  type KitchenResult,
  parseKitchenConfig,
  sendToKitchen,
} from './kitchen/client.ts';
export {
  KITCHEN_FRAGMENT_KEY,
  type KitchenFragment,
  readKitchenFragment,
} from './kitchen/fragment.ts';
export {
  createPlannerAssistant,
  type PlannerAssistant,
  type PlannerChatInference,
  type PlannerConfigInference,
  type PlannerInference,
} from './planner/assistant.ts';
export type {
  PlannerBridgeApplyReply,
  PlannerBridgeContext,
  PlannerBridgeExecute,
  PlannerBridgeRequest,
  PlannerBridgeResult,
  PlannerBridgeSnapshot,
  PlannerCommandPortClient,
} from './planner/bridge.ts';
export {
  bindPlannerCommandPort,
  connectPlannerCommandPort,
} from './planner/bridge.ts';
export * from './planner/commands/index.ts';
export { capturePlannerExport } from './planner/export-context.ts';
export type {
  PlannerGuideHandle,
  PlannerGuideResult,
} from './planner/guide.ts';
export { default as HostPlanner } from './planner/host/HostPlanner.svelte';
export {
  type CallKitchenTool,
  createHostSession,
  type HostPlan,
  type HostSession,
} from './planner/host/session.svelte.ts';
export type { PlannerHostReplyResult } from './planner/host-reply.ts';
export { applyPlannerHostReply } from './planner/host-reply.ts';
export { plannerController } from './planner/instance.ts';
export { default as Planner } from './planner/Planner.svelte';
export { default as PlannerControls } from './planner/PlannerControls.svelte';
export {
  PLANNER_SHELL_EDGE_TOGGLES,
  PLANNER_SHELL_PANEL_DEFAULTS,
  plannerShellProps,
} from './planner/shell.ts';
export type {
  PlannerBackLink,
  PlannerExportAction,
  PlannerExportContext,
  PlannerHandle,
  PlannerProjectPersistence,
  PlannerProps,
} from './planner/types.ts';
