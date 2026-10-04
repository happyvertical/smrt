import { defineMessages } from '@happyvertical/smrt-ui/i18n';

/**
 * Message catalog for the HR components. Keys are
 * `human_resources.<component>.<key>`; `human_resources.expiry.*` is shared by
 * the two qualification lists.
 */
export const M = defineMessages({
  'human_resources.employee_list.caption': 'Employees',
  'human_resources.employee_list.empty': 'No employees',
  'human_resources.employee_list.name': 'Name',
  'human_resources.employee_list.employee_number': 'Employee number',
  'human_resources.employee_list.position': 'Position',
  'human_resources.employee_list.worker_type': 'Worker type',
  'human_resources.employee_list.status': 'Status',
  'human_resources.employee_list.started_on': 'Start date',
  'human_resources.employee_list.status_active': 'Active',
  'human_resources.employee_list.status_on_leave': 'On leave',
  'human_resources.employee_list.status_ended': 'Ended',
  'human_resources.employee_list.last_day': 'Last day {date}',
  'human_resources.employee_list.none': 'None',
  'human_resources.employee_list.select_aria': 'Open employee: {name}',

  'human_resources.employee_form.employee_number': 'Employee number',
  'human_resources.employee_form.employee_number_edit_help':
    'The employee number cannot be changed.',
  'human_resources.employee_form.worker_type': 'Worker type',
  'human_resources.employee_form.worker_type_help':
    'Pick a suggestion or enter your own: lowercase words joined by hyphens.',
  'human_resources.employee_form.position': 'Position',
  'human_resources.employee_form.started_on': 'Start date',
  'human_resources.employee_form.effective_on': 'Effective date',
  'human_resources.employee_form.effective_on_help':
    'The day these changes take effect.',
  'human_resources.employee_form.login': 'Login',
  'human_resources.employee_form.login_help':
    'Optional. A worker who signs in on a shared device may have none.',
  'human_resources.employee_form.login_none': 'No login',
  'human_resources.employee_form.login_current': 'Current login ({id})',
  'human_resources.employee_form.submit_hire': 'Hire employee',
  'human_resources.employee_form.submit_edit': 'Save changes',
  'human_resources.employee_form.saving': 'Saving...',
  'human_resources.employee_form.cancel': 'Cancel',
  'human_resources.employee_form.error_employee_number':
    'Enter an employee number.',
  'human_resources.employee_form.error_worker_type':
    'Enter a worker type using lowercase words joined by hyphens.',
  'human_resources.employee_form.error_started_on': 'Enter a start date.',
  'human_resources.employee_form.error_effective_on':
    'Enter an effective date.',

  'human_resources.person_qualifications.empty': 'No qualifications',
  'human_resources.person_qualifications.select_aria':
    'Open qualification: {name}',
  'human_resources.person_qualifications.certificate':
    'Certificate {certificateNumber}',
  'human_resources.person_qualifications.issued_on': 'Issued {date}',
  'human_resources.person_qualifications.expires_on': 'Expires {date}',
  'human_resources.person_qualifications.no_expiry': 'Does not expire',
  'human_resources.person_qualifications.state_valid': 'Valid',
  'human_resources.person_qualifications.state_expiring_soon': 'Expiring soon',
  'human_resources.person_qualifications.state_expired': 'Expired',
  'human_resources.person_qualifications.state_suspended': 'Suspended',
  'human_resources.person_qualifications.state_revoked': 'Revoked',
  'human_resources.person_qualifications.state_not_yet_issued':
    'Not yet issued',
  'human_resources.person_qualifications.kind_ticket': 'Ticket',
  'human_resources.person_qualifications.kind_certification': 'Certification',
  'human_resources.person_qualifications.kind_authorization': 'Authorization',
  'human_resources.person_qualifications.kind_training': 'Training',
  'human_resources.person_qualifications.kind_restriction': 'Restriction',

  'human_resources.expiring_qualifications_list.empty':
    'No qualifications expiring soon',
  'human_resources.expiring_qualifications_list.select_aria':
    'Open qualification: {qualification} held by {name}',
  'human_resources.expiring_qualifications_list.expires_on': 'Expires {date}',

  'human_resources.expiry.today': 'Today',
  'human_resources.expiry.in_one_day': 'In 1 day',
  'human_resources.expiry.in_days': 'In {days} days',
  'human_resources.expiry.one_day_ago': '1 day ago',
  'human_resources.expiry.days_ago': '{days} days ago',
});
