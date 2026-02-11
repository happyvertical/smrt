/**
 * Jobs Module Svelte Components
 *
 * Optional Svelte UI components for background job management.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import { JOBS_MODULE_META } from '../ui.js';

// Import components
import JobActions from './components/JobActions.svelte';
import JobDashboard from './components/JobDashboard.svelte';
import JobDetail from './components/JobDetail.svelte';
import JobList from './components/JobList.svelte';
import JobStats from './components/JobStats.svelte';
import JobStatusBadge from './components/JobStatusBadge.svelte';

// Export components
export {
  JobActions,
  JobDashboard,
  JobDetail,
  JobList,
  JobStats,
  JobStatusBadge,
};

// Export component prop types
export type { Props as JobActionsProps } from './components/JobActions.svelte';
export type { Props as JobDashboardProps } from './components/JobDashboard.svelte';
export type { Props as JobDetailProps } from './components/JobDetail.svelte';
export type { Props as JobListProps } from './components/JobList.svelte';
export type { Props as JobStatsProps } from './components/JobStats.svelte';
export type { Props as JobStatusBadgeProps } from './components/JobStatusBadge.svelte';

// Export types and utilities
export type {
  JobActionsProps as JobActionsPropsLegacy,
  JobDashboardProps as JobDashboardPropsLegacy,
  JobData,
  JobDetailProps as JobDetailPropsLegacy,
  JobFilter,
  JobListProps as JobListPropsLegacy,
  JobPriority,
  JobSort,
  JobStats as JobStatsData,
  JobStatsProps as JobStatsPropsLegacy,
  JobStatus,
  QueueStats,
  TimeoutBehavior,
} from './types.js';

export {
  formatDuration,
  formatRelativeTime,
  getPriorityClass,
  getPriorityLabel,
  getStatusVariant,
} from './types.js';

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(JOBS_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-jobs',
  'job-dashboard',
  JobDashboard,
);
ModuleUIRegistry.register('@happyvertical/smrt-jobs', 'job-list', JobList);
ModuleUIRegistry.register('@happyvertical/smrt-jobs', 'job-detail', JobDetail);
ModuleUIRegistry.register('@happyvertical/smrt-jobs', 'job-stats', JobStats);
ModuleUIRegistry.register(
  '@happyvertical/smrt-jobs',
  'job-actions',
  JobActions,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-jobs',
  'job-status-badge',
  JobStatusBadge,
);
