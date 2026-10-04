/**
 * Timesheets Module UI Slot Declarations
 *
 * UI extension points for the timesheets module. Components are implemented in
 * the ./svelte subpath and are props-driven: hosts load entries and pass plain
 * view objects.
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Timesheets module UI slots
 */
export const TIMESHEETS_UI_SLOTS: Record<string, ModuleUISlot> = {
  'time-entry-card': {
    id: 'time-entry-card',
    label: 'Time Entry Card',
    description: 'Card component for displaying time entries',
    icon: 'clock',
    category: 'display',
    order: 1,
    propsInterface: 'TimeEntryCardProps',
  },
  'time-entry-list': {
    id: 'time-entry-list',
    label: 'Time Entry List',
    description: 'List of time entries with optional selection',
    icon: 'list',
    category: 'list',
    order: 2,
    propsInterface: 'TimeEntryListProps',
  },
  'time-summary': {
    id: 'time-summary',
    label: 'Time Summary',
    description: 'Summary statistics for time entries',
    icon: 'chart',
    category: 'display',
    order: 3,
    propsInterface: 'TimeSummaryProps',
  },
  'duration-display': {
    id: 'duration-display',
    label: 'Duration Display',
    description: 'Formats hours for display in decimal or HH:MM format',
    icon: 'timer',
    category: 'display',
    order: 4,
    propsInterface: 'DurationDisplayProps',
  },
  'time-entry-approval-queue': {
    id: 'time-entry-approval-queue',
    label: 'Time Entry Approval Queue',
    description: 'Review list with approve and reject-with-reason actions',
    icon: 'check',
    category: 'action',
    order: 5,
    propsInterface: 'TimeEntryApprovalQueueProps',
  },
};

/**
 * Timesheets module metadata
 */
export const TIMESHEETS_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-timesheets',
  displayName: 'Timesheets',
  description:
    'Shared time entries with approval, correction, and immutable commercial snapshots',
  uiSlots: TIMESHEETS_UI_SLOTS,
  models: [
    'ServiceTimeEntry',
    'ServiceChargeSnapshot',
    'ServiceCompensationSnapshot',
  ],
  collections: [
    'ServiceTimeEntryCollection',
    'ServiceChargeSnapshotCollection',
    'ServiceCompensationSnapshotCollection',
  ],
};
