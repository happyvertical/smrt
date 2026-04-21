/**
 * Projects Module UI Slot Declarations
 *
 * This file defines the UI extension points for the projects module.
 * UI components are implemented in the ./svelte subpath.
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import './__smrt-register__.js';

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Projects module UI slots
 */
export const PROJECTS_UI_SLOTS: Record<string, ModuleUISlot> = {
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
  'approval-actions': {
    id: 'approval-actions',
    label: 'Approval Actions',
    description: 'Status-based action buttons for approval workflow',
    icon: 'check',
    category: 'action',
    order: 5,
    propsInterface: 'ApprovalActionsProps',
  },
  'bulk-actions': {
    id: 'bulk-actions',
    label: 'Bulk Actions',
    description: 'Action bar for bulk operations on selected items',
    icon: 'select-all',
    category: 'action',
    order: 6,
    propsInterface: 'BulkActionsProps',
  },
  'reject-dialog': {
    id: 'reject-dialog',
    label: 'Reject Dialog',
    description: 'Modal dialog for rejecting with a reason',
    icon: 'x-circle',
    category: 'form',
    order: 7,
    propsInterface: 'RejectDialogProps',
  },
};

/**
 * Projects module metadata
 */
export const PROJECTS_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-projects',
  displayName: 'Projects',
  description: 'Provider-agnostic project management with time tracking',
  uiSlots: PROJECTS_UI_SLOTS,
  models: ['Repository', 'Issue', 'PullRequest', 'Project', 'Comment', 'Label'],
  collections: [
    'RepositoryCollection',
    'IssueCollection',
    'PullRequestCollection',
    'ProjectCollection',
    'CommentCollection',
    'LabelCollection',
  ],
};
