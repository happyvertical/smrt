/**
 * Agents Module Svelte Components
 *
 * Optional Svelte UI components for agent schedule management.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import '../__smrt-register__.js';

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import type { ComponentProps } from 'svelte';
import { AGENTS_MODULE_META } from '../ui.js';

// Import components
import AgentDashboard from './components/AgentDashboard.svelte';
import AgentRunHistory from './components/AgentRunHistory.svelte';
import AgentScheduleForm from './components/AgentScheduleForm.svelte';
import AgentScheduleList from './components/AgentScheduleList.svelte';
import ScheduleStatusBadge from './components/ScheduleStatusBadge.svelte';

// Export components
export {
  AgentDashboard,
  AgentRunHistory,
  AgentScheduleForm,
  AgentScheduleList,
  ScheduleStatusBadge,
};

// Export component prop types
export type AgentDashboardProps = ComponentProps<typeof AgentDashboard>;
export type AgentRunHistoryProps = ComponentProps<typeof AgentRunHistory>;
export type AgentScheduleFormProps = ComponentProps<typeof AgentScheduleForm>;
export type AgentScheduleListProps = ComponentProps<typeof AgentScheduleList>;
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
