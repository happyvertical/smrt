/**
 * Agents Module Svelte Components
 *
 * Optional Svelte UI components for agent schedule management and the
 * agent-admin shells (AgentAdminPanel / AgentAdminTabs / AgentSettingsShell)
 * that render UI-slot config panels against the agent UI registry.
 * Schedule components auto-register with ModuleUIRegistry on import; the admin
 * shells are imported directly (not module-registry discoverable).
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import type { ComponentProps } from 'svelte';
import { AGENTS_MODULE_META } from '../ui.js';

// Import components
import AgentAdminPanel from './components/AgentAdminPanel.svelte';
import AgentAdminTabs from './components/AgentAdminTabs.svelte';
import AgentDashboard from './components/AgentDashboard.svelte';
import AgentRunHistory from './components/AgentRunHistory.svelte';
import AgentScheduleForm from './components/AgentScheduleForm.svelte';
import AgentScheduleList from './components/AgentScheduleList.svelte';
import AgentSettingsShell from './components/AgentSettingsShell.svelte';
import ScheduleStatusBadge from './components/ScheduleStatusBadge.svelte';

// Export components
export {
  AgentAdminPanel,
  AgentAdminTabs,
  AgentDashboard,
  AgentRunHistory,
  AgentScheduleForm,
  AgentScheduleList,
  AgentSettingsShell,
  ScheduleStatusBadge,
};

// Export component prop types
export type AgentAdminPanelProps = ComponentProps<typeof AgentAdminPanel>;
export type AgentAdminTabsProps = ComponentProps<typeof AgentAdminTabs>;
export type AgentDashboardProps = ComponentProps<typeof AgentDashboard>;
export type AgentRunHistoryProps = ComponentProps<typeof AgentRunHistory>;
export type AgentScheduleFormProps = ComponentProps<typeof AgentScheduleForm>;
export type AgentScheduleListProps = ComponentProps<typeof AgentScheduleList>;
export type AgentSettingsShellProps = ComponentProps<typeof AgentSettingsShell>;
export type ScheduleStatusBadgeProps = ComponentProps<
  typeof ScheduleStatusBadge
>;

// Export types and utilities
export type {
  AgentDashboardProps as AgentDashboardPropsLegacy,
  AgentRunHistoryEntry,
  AgentRunHistoryProps as AgentRunHistoryPropsLegacy,
  AgentScheduleData,
  AgentScheduleFormProps as AgentScheduleFormPropsLegacy,
  AgentScheduleListProps as AgentScheduleListPropsLegacy,
  RunStatus,
  ScheduleFormData,
  ScheduleStatus,
} from './types.js';

export {
  calculateSuccessRate,
  formatCronExpression,
  formatDuration,
  formatRelativeTime,
  getRunStatusVariant,
  getScheduleStatusVariant,
} from './types.js';

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(AGENTS_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-agents',
  'agent-dashboard',
  AgentDashboard,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-agents',
  'agent-schedule-list',
  AgentScheduleList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-agents',
  'agent-schedule-form',
  AgentScheduleForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-agents',
  'agent-run-history',
  AgentRunHistory,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-agents',
  'schedule-status-badge',
  ScheduleStatusBadge,
);
