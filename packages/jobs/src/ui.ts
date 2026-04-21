/**
 * Jobs Module UI Slot Declarations
 *
 * This file defines the UI extension points for the jobs module.
 * UI components are implemented in the ./svelte subpath.
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import './__smrt-register__.js';

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Jobs module UI slots
 */
export const JOBS_UI_SLOTS: Record<string, ModuleUISlot> = {
  'job-dashboard': {
    id: 'job-dashboard',
    label: 'Job Dashboard',
    description: 'Combined overview panel for background jobs',
    icon: 'briefcase',
    category: 'admin',
    order: 1,
    propsInterface: 'JobDashboardProps',
  },
  'job-list': {
    id: 'job-list',
    label: 'Job List',
    description: 'Filterable, sortable list of background jobs',
    icon: 'list',
    category: 'list',
    order: 2,
    propsInterface: 'JobListProps',
  },
  'job-detail': {
    id: 'job-detail',
    label: 'Job Detail',
    description: 'Detailed view of a single job',
    icon: 'file-text',
    category: 'detail',
    order: 3,
    propsInterface: 'JobDetailProps',
  },
  'job-stats': {
    id: 'job-stats',
    label: 'Job Stats',
    description: 'Statistics dashboard for job queues',
    icon: 'bar-chart',
    category: 'display',
    order: 4,
    propsInterface: 'JobStatsProps',
  },
  'job-actions': {
    id: 'job-actions',
    label: 'Job Actions',
    description: 'Action buttons for job operations',
    icon: 'more-horizontal',
    category: 'action',
    order: 5,
    propsInterface: 'JobActionsProps',
  },
  'job-status-badge': {
    id: 'job-status-badge',
    label: 'Job Status Badge',
    description: 'Status indicator for job states',
    icon: 'tag',
    category: 'display',
    order: 6,
    propsInterface: 'JobStatusBadgeProps',
  },
};

/**
 * Jobs module metadata
 */
export const JOBS_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-jobs',
  displayName: 'Jobs',
  description: 'Background job processing with persistence and scheduling',
  uiSlots: JOBS_UI_SLOTS,
  models: ['Job', 'JobQueue'],
  collections: ['JobCollection', 'JobQueueCollection'],
};
