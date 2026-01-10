/**
 * Projects Module Svelte Components
 *
 * Optional Svelte UI components for time tracking and project management.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import { PROJECTS_MODULE_META } from '../ui.js';

// Export components
export { default as ApprovalActions } from './components/ApprovalActions.svelte';
export { default as BulkActions } from './components/BulkActions.svelte';
export { default as DurationDisplay } from './components/DurationDisplay.svelte';
export { default as RejectDialog } from './components/RejectDialog.svelte';
export { default as TimeEntryCard } from './components/TimeEntryCard.svelte';
export { default as TimeEntryList } from './components/TimeEntryList.svelte';
export { default as TimeSummary } from './components/TimeSummary.svelte';

// Export types and utilities
export {
  type ApprovalStatus,
  type Currency,
  formatCurrency,
  formatDate,
  formatHours,
  formatHoursHHMM,
  statusColors,
  type TimeEntry,
  type TimeEntryStatus,
} from './utils.js';

// Auto-register with ModuleUIRegistry
import ApprovalActions from './components/ApprovalActions.svelte';
import BulkActions from './components/BulkActions.svelte';
import DurationDisplay from './components/DurationDisplay.svelte';
import RejectDialog from './components/RejectDialog.svelte';
import TimeEntryCard from './components/TimeEntryCard.svelte';
import TimeEntryList from './components/TimeEntryList.svelte';
import TimeSummary from './components/TimeSummary.svelte';

ModuleUIRegistry.registerModule(PROJECTS_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'time-entry-card',
  TimeEntryCard,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'time-entry-list',
  TimeEntryList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'time-summary',
  TimeSummary,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'duration-display',
  DurationDisplay,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'approval-actions',
  ApprovalActions,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'bulk-actions',
  BulkActions,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'reject-dialog',
  RejectDialog,
);
