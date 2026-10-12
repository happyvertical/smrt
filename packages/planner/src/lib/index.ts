/**
 * smrt planner as a package: mount `Planner` for the full app shell, or
 * `PlannerControls` inside a host-owned shell,
 * drive it with the typed command set (`./commands` has no UI in it), and read
 * its plan as a compact snapshot.
 *
 * @module
 */
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
export * from './planner/commands/index.ts';
export { default as HostPlanner } from './planner/host/HostPlanner.svelte';
export {
  type CallKitchenTool,
  createHostSession,
  type HostPlan,
  type HostSession,
} from './planner/host/session.svelte.ts';
export { plannerController } from './planner/instance.ts';
export { default as Planner } from './planner/Planner.svelte';
export { default as PlannerControls } from './planner/PlannerControls.svelte';
export {
  PLANNER_SHELL_EDGE_TOGGLES,
  PLANNER_SHELL_PANEL_DEFAULTS,
  plannerShellProps,
} from './planner/shell.ts';
export type { PlannerHandle, PlannerProps } from './planner/types.ts';
