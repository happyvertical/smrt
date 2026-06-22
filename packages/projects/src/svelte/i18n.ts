import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  'projects.approval_actions.approved_message': 'This entry has been approved',
  'projects.approval_actions.rejected_message': 'This entry was rejected',
  'projects.bulk_actions.approve_all': 'Approve All',
  'projects.bulk_actions.reject_all': 'Reject All',
  'projects.reject_dialog.reason_required': 'A reason is required to reject',
  'projects.reject_dialog.close_dialog': 'Close dialog',
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
});
