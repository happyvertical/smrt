import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // Grid and edit chrome
  'ui.overview.label': 'Overview widgets',
  'ui.overview.empty': 'There are no widgets on this overview yet.',
  'ui.overview.toolbar': 'Customize overview',
  'ui.overview.add': 'Add widget',
  'ui.overview.add_title': 'Add a widget',
  'ui.overview.add_none': 'No more widgets can be added to this overview.',
  'ui.overview.reset': 'Reset overview to default',
  'ui.overview.move': 'Move {widget}',
  'ui.overview.resize': 'Resize {widget}',
  'ui.overview.resize_value': '{span} of {max} columns',
  'ui.overview.configure': 'Configure {widget}',
  'ui.overview.remove': 'Remove {widget}',
  'ui.overview.item': '{widget}, position {position} of {count}',
  // Live announcements
  'ui.overview.announce_pickup':
    'Picked up {widget}. Use the arrow keys to choose a position, then Space or Enter to drop. Escape cancels.',
  'ui.overview.announce_position': '{widget}, position {position} of {count}.',
  'ui.overview.announce_drop':
    'Moved {widget} to position {position} of {count}.',
  'ui.overview.announce_cancel': 'Cancelled moving {widget}.',
  'ui.overview.announce_failed':
    'Could not move {widget}. The order was restored.',
  'ui.overview.announce_resized':
    '{widget} is now {span} of {max} columns wide.',
  'ui.overview.announce_removed': 'Removed {widget}.',
  'ui.overview.announce_added': 'Added {widget}.',
  'ui.overview.announce_configured': 'Updated {widget}.',
  'ui.overview.announce_reset': 'Overview reset to its default.',
  'ui.overview.announce_denied': 'You cannot change this overview.',
  // Assistant changes (phase 4)
  'ui.overview.assistant_applied': 'The assistant updated this overview.',
  'ui.overview.assistant_undo': 'Undo',
  'ui.overview.assistant_dismiss': 'Dismiss',
  'ui.overview.assistant_undone': 'The assistant change was undone.',
  'ui.overview.assistant_changed_since':
    'The overview changed after the assistant edit, so it was not undone.',
  'ui.overview.assistant_undo_failed':
    'The assistant change could not be undone.',
  // Widget states
  'ui.overview.loading': 'Loading',
  'ui.overview.error': 'This widget could not be loaded.',
  'ui.overview.retry': 'Try again',
  'ui.overview.unavailable': 'This widget is not available.',
  'ui.overview.no_data': 'Nothing to show yet.',
  // Option editor
  'ui.overview.options_title': 'Configure {widget}',
  'ui.overview.options_new_title': 'Add {widget}',
  'ui.overview.options_save': 'Save',
  'ui.overview.options_cancel': 'Cancel',
  'ui.overview.options_none': 'This widget has no options.',
  'ui.overview.options_choose': 'Choose',
  'ui.overview.options_failed': 'Some options need attention.',
  'ui.overview.issue_required': 'This field is required.',
  'ui.overview.issue_invalid_type': 'This value is not valid.',
  'ui.overview.issue_too_long': 'This value is too long.',
  'ui.overview.issue_out_of_range': 'This value is out of range.',
  'ui.overview.issue_not_in_choices': 'Choose one of the listed values.',
  'ui.overview.issue_invalid_format':
    'Use letters, digits and the simple separators only.',
  'ui.overview.issue_not_allowed': 'This is not available on this overview.',
  'ui.overview.issue_unknown_option': 'This option is not recognised.',
  // Core widgets: titles and descriptions
  'ui.overview.widget.metric.title': 'Metric',
  'ui.overview.widget.metric.description':
    'One number, such as a count or a total.',
  'ui.overview.widget.chart.title': 'Chart',
  'ui.overview.widget.chart.description':
    'Values grouped over a period, as bars or a line.',
  'ui.overview.widget.records.title': 'Record list',
  'ui.overview.widget.records.description':
    'The latest or top records of a model.',
  'ui.overview.widget.shortcuts.title': 'Shortcuts',
  'ui.overview.widget.shortcuts.description':
    'Cards that link to a section’s pages.',
  'ui.overview.widget.note.title': 'Note',
  'ui.overview.widget.note.description': 'Text with simple formatting.',
  // Core widgets: options
  'ui.overview.opt.title': 'Title',
  'ui.overview.opt.title_help':
    'Shown above the widget. Leave empty for the default.',
  'ui.overview.opt.model': 'Model',
  'ui.overview.opt.model_help': 'Which records the widget reads.',
  'ui.overview.opt.measure': 'Measure',
  'ui.overview.opt.measure_count': 'Count',
  'ui.overview.opt.measure_sum': 'Sum',
  'ui.overview.opt.measure_avg': 'Average',
  'ui.overview.opt.measure_min': 'Smallest',
  'ui.overview.opt.measure_max': 'Largest',
  'ui.overview.opt.field': 'Field',
  'ui.overview.opt.field_help': 'The field to sum or average.',
  'ui.overview.opt.filter': 'Filter',
  'ui.overview.opt.filter_help': 'A named filter the data source offers.',
  'ui.overview.opt.group_by': 'Group by',
  'ui.overview.opt.period': 'Period',
  'ui.overview.opt.period_7d': 'Last 7 days',
  'ui.overview.opt.period_30d': 'Last 30 days',
  'ui.overview.opt.period_90d': 'Last 90 days',
  'ui.overview.opt.period_12m': 'Last 12 months',
  'ui.overview.opt.period_all': 'All time',
  'ui.overview.opt.style': 'Style',
  'ui.overview.opt.style_bar': 'Bars',
  'ui.overview.opt.style_line': 'Line',
  'ui.overview.opt.sort': 'Sort by',
  'ui.overview.opt.direction': 'Direction',
  'ui.overview.opt.direction_desc': 'Newest or largest first',
  'ui.overview.opt.direction_asc': 'Oldest or smallest first',
  'ui.overview.opt.limit': 'Rows',
  'ui.overview.opt.section': 'Section',
  'ui.overview.opt.section_help':
    'The navigation section whose pages are shown.',
  'ui.overview.opt.body': 'Text',
  'ui.overview.opt.body_help':
    'Supports headings, lists, bold, italic, code and links.',
  // Core widgets: content
  'ui.overview.metric.change_up': 'Up {value} from the previous period',
  'ui.overview.metric.change_down': 'Down {value} from the previous period',
  'ui.overview.chart.summary': 'Chart with {count} values',
  'ui.overview.chart.table': 'Chart data',
  'ui.overview.chart.label_column': 'Label',
  'ui.overview.chart.value_column': 'Value',
  'ui.overview.records.empty': 'No records to show.',
  'ui.overview.records.view_all': 'View all',
  'ui.overview.records.total': '{count} in total',
  'ui.overview.shortcuts.empty': 'No pages to show.',
});
