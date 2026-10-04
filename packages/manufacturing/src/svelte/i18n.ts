import { defineMessages } from '@happyvertical/smrt-ui/i18n';

/**
 * Message catalog for the manufacturing components. Keys are
 * `manufacturing.<component>.<key>`.
 */
export const M = defineMessages({
  'manufacturing.operation_list.caption': 'Operations',
  'manufacturing.operation_list.empty': 'No operations',
  'manufacturing.operation_list.code': 'Code',
  'manufacturing.operation_list.name': 'Name',
  'manufacturing.operation_list.category': 'Category',
  'manufacturing.operation_list.status': 'Status',
  'manufacturing.operation_list.actions': 'Actions',
  'manufacturing.operation_list.active': 'Active',
  'manufacturing.operation_list.retired': 'Retired',
  'manufacturing.operation_list.none': 'None',
  'manufacturing.operation_list.select_aria': 'Edit operation: {name}',
  'manufacturing.operation_list.retire': 'Retire',
  'manufacturing.operation_list.retire_aria': 'Retire operation: {name}',
  'manufacturing.operation_list.reinstate': 'Reinstate',
  'manufacturing.operation_list.reinstate_aria': 'Reinstate operation: {name}',

  'manufacturing.operation_form.code': 'Code',
  'manufacturing.operation_form.code_edit_help': 'The code cannot be changed.',
  'manufacturing.operation_form.name': 'Name',
  'manufacturing.operation_form.category': 'Category',
  'manufacturing.operation_form.category_help':
    'Optional. Groups operations in lists.',
  'manufacturing.operation_form.qualification': 'Required qualification',
  'manufacturing.operation_form.qualification_help':
    'Optional. The id of the qualification a worker needs to start this operation.',
  'manufacturing.operation_form.submit_add': 'Add operation',
  'manufacturing.operation_form.submit_edit': 'Save changes',
  'manufacturing.operation_form.saving': 'Saving...',
  'manufacturing.operation_form.cancel': 'Cancel',
  'manufacturing.operation_form.error_code': 'Enter a code.',
  'manufacturing.operation_form.error_name': 'Enter a name.',
});
