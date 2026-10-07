import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  'ui.sortable.label': 'Sortable list',
  'ui.sortable.move': 'Move {item}',
  'ui.sortable.group': '{label}, {count} items',
  'ui.sortable.empty': 'No items in {container}.',
  'ui.sortable.pickup':
    'Picked up {item}. Available destinations: {destinations}. Use the up and down arrow keys to choose a position, then Space or Enter to drop. Escape cancels.',
  'ui.sortable.position':
    '{item}, position {position} of {count} in {container}.',
  'ui.sortable.drop':
    'Moved {item} to {container}, position {position} of {count}.',
  'ui.sortable.failed': 'Could not move {item}. The list was restored.',
  'ui.sortable.cancel': 'Cancelled moving {item}.',
  'ui.sortable.unavailable': '{container} is unavailable.',
});
