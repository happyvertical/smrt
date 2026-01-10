// Admin Panel Components
// These components work with @happyvertical/smrt-agents to render
// agent admin panels dynamically based on the AgentUIRegistry.

// Re-export relevant types for convenience
export type {
  AdminPanelBaseProps,
  AgentUIComponentRegistry,
  AgentUISlot,
  AgentUISlots,
} from '@happyvertical/smrt-agents/ui';
export { default as AgentAdminPanel } from './AgentAdminPanel.svelte';
export { default as AgentAdminTabs } from './AgentAdminTabs.svelte';
export { default as AgentSettingsShell } from './AgentSettingsShell.svelte';
