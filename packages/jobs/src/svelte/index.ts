/**
 * Jobs Module Svelte Components
 *
 * Optional Svelte UI components for background job management.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import type { ComponentProps } from 'svelte';
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
export type JobActionsProps = ComponentProps<typeof JobActions>;
export type JobDashboardProps = ComponentProps<typeof JobDashboard>;
export type JobDetailProps = ComponentProps<typeof JobDetail>;
export type JobListProps = ComponentProps<typeof JobList>;
export type JobStatsProps = ComponentProps<typeof JobStats>;
export type JobStatusBadgeProps = ComponentProps<typeof JobStatusBadge>;

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
