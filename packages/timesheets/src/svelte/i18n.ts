import { defineMessages } from '@happyvertical/smrt-ui/i18n';

/**
 * Message catalog for the timesheets components.
 *
 * The card, list, and summary keys keep the `projects.` namespace they shipped
 * under before these components moved here (#3288): tenant language overrides
 * are stored by key, so renaming them would orphan existing translations.
 * Components added in this package use the `timesheets.` namespace.
 */
export const M = defineMessages({
  'projects.time_entry_card.mileage': '+ {mileage} km mileage',
  'projects.time_entry_card.select_entry':
    'Select time entry for {description}',
  'projects.time_entry_list.select_all': 'Select All',
  'projects.time_entry_list.selection_count': '{selected} of {total} selected',
  'projects.time_entry_list.select_all_aria': 'Select all time entries',
  'projects.time_entry_list.select_entry_aria': 'Select entry: {description}',
  'projects.time_summary.total_hours': 'Total Hours',
  'projects.time_summary.total_value': 'Total Value',
  'projects.time_summary.pending_approval': 'Pending Approval',
  'timesheets.approval_queue.empty': 'No time entries',
  'timesheets.approval_queue.reason_placeholder': 'Rejection reason',
  'timesheets.approval_queue.reason_aria':
    'Rejection reason for: {description}',
  'timesheets.approval_queue.confirm_reject': 'Confirm reject',
  'timesheets.approval_queue.confirm_reject_aria':
    'Confirm rejection of: {description}',
  'timesheets.approval_queue.cancel': 'Cancel',
  'timesheets.approval_queue.cancel_aria': 'Cancel rejecting: {description}',
  'timesheets.approval_queue.approve': 'Approve',
  'timesheets.approval_queue.approve_aria': 'Approve time entry: {description}',
  'timesheets.approval_queue.reject': 'Reject',
  'timesheets.approval_queue.reject_aria': 'Reject time entry: {description}',
});
