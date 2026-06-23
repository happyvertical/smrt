/**
 * Side-effect-free agent-admin shells.
 *
 * Exposes the agent-admin composites (`AgentAdminPanel` / `AgentAdminTabs` /
 * `AgentSettingsShell`) and the registry types they take WITHOUT the schedule
 * component `ModuleUIRegistry` auto-registration that the `./svelte` barrel runs
 * on import. Consumers that only render the admin shells should import from here
 * — it preserves the side-effect-free semantics of the former
 * `@happyvertical/smrt-svelte/admin` subpath (#1589).
 */
import type { ComponentProps } from 'svelte';
import AgentAdminPanel from './components/AgentAdminPanel.svelte';
import AgentAdminTabs from './components/AgentAdminTabs.svelte';
import AgentSettingsShell from './components/AgentSettingsShell.svelte';

export { AgentAdminPanel, AgentAdminTabs, AgentSettingsShell };

export type AgentAdminPanelProps = ComponentProps<typeof AgentAdminPanel>;
export type AgentAdminTabsProps = ComponentProps<typeof AgentAdminTabs>;
export type AgentSettingsShellProps = ComponentProps<typeof AgentSettingsShell>;

// The registry contracts the admin shells type against (parity with the former
// smrt-svelte/admin barrel, which re-exported these). They live in
// smrt-agents/ui.
export type {
  AdminPanelBaseProps,
  AgentUIComponentRegistry,
  AgentUISlot,
  AgentUISlots,
} from '../ui.js';
