/**
 * Agents Module Svelte Components
 *
 * Optional Svelte UI components for agent schedule management.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
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
export type { Props as AgentDashboardProps } from './components/AgentDashboard.svelte';
export type { Props as AgentRunHistoryProps } from './components/AgentRunHistory.svelte';
export type { Props as AgentScheduleFormProps } from './components/AgentScheduleForm.svelte';
export type { Props as AgentScheduleListProps } from './components/AgentScheduleList.svelte';
export type { Props as ScheduleStatusBadgeProps } from './components/ScheduleStatusBadge.svelte';

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
