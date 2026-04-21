/**
 * Projects Module Svelte Components
 *
 * Optional Svelte UI components for time tracking and project management.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import '../__smrt-register__.js';

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import type { ComponentProps } from 'svelte';
import { PROJECTS_MODULE_META } from '../ui.js';

// Import components
import ApprovalActions from './components/ApprovalActions.svelte';
import BulkActions from './components/BulkActions.svelte';
import DurationDisplay from './components/DurationDisplay.svelte';
import RejectDialog from './components/RejectDialog.svelte';
import TimeEntryCard from './components/TimeEntryCard.svelte';
import TimeEntryList from './components/TimeEntryList.svelte';
import TimeSummary from './components/TimeSummary.svelte';

// Export components
export {
  ApprovalActions,
  BulkActions,
  DurationDisplay,
  RejectDialog,
  TimeEntryCard,
  TimeEntryList,
  TimeSummary,
};

// Export component prop types
export type ApprovalActionsProps = ComponentProps<typeof ApprovalActions>;
export type BulkActionsProps = ComponentProps<typeof BulkActions>;
export type DurationDisplayProps = ComponentProps<typeof DurationDisplay>;
export type RejectDialogProps = ComponentProps<typeof RejectDialog>;
export type TimeEntryCardProps = ComponentProps<typeof TimeEntryCard>;
export type TimeEntryListProps = ComponentProps<typeof TimeEntryList>;
export type TimeSummaryProps = ComponentProps<typeof TimeSummary>;

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
