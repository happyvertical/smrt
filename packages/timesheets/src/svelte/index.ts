/**
 * @happyvertical/smrt-timesheets/svelte
 *
 * Props-driven Svelte 5 surfaces for time entries: a card, a selectable list,
 * a summary, a duration formatter, and an approval queue. Hosts load data
 * through the package models/services and pass plain view objects.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import type { ComponentProps } from 'svelte';
import { TIMESHEETS_MODULE_META } from '../ui.js';
import DurationDisplay from './components/DurationDisplay.svelte';
import TimeEntryApprovalQueue from './components/TimeEntryApprovalQueue.svelte';
import TimeEntryCard from './components/TimeEntryCard.svelte';
import TimeEntryList from './components/TimeEntryList.svelte';
import TimeSummary from './components/TimeSummary.svelte';

export {
  DurationDisplay,
  TimeEntryApprovalQueue,
  TimeEntryCard,
  TimeEntryList,
  TimeSummary,
};

export type DurationDisplayProps = ComponentProps<typeof DurationDisplay>;
export type TimeEntryApprovalQueueProps = ComponentProps<
  typeof TimeEntryApprovalQueue
>;
export type TimeEntryCardProps = ComponentProps<typeof TimeEntryCard>;
export type TimeEntryListProps = ComponentProps<typeof TimeEntryList>;
export type TimeSummaryProps = ComponentProps<typeof TimeSummary>;

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
} from './components/utils.js';
export {
  humanizeTimeEntryStatus,
  type TimeEntryApprovalView,
  timeEntryStatusBadgeKey,
} from './types.js';

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(TIMESHEETS_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-timesheets',
  'time-entry-card',
  TimeEntryCard,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-timesheets',
  'time-entry-list',
  TimeEntryList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-timesheets',
  'time-summary',
  TimeSummary,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-timesheets',
  'duration-display',
  DurationDisplay,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-timesheets',
  'time-entry-approval-queue',
  TimeEntryApprovalQueue,
);
