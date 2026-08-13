import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  'ui.board.label': 'Board',
  'ui.board.column': '{label}, {count} cards',
  'ui.board.collapse_column': 'Collapse {label}',
  'ui.board.expand_column': 'Expand {label}',
  'ui.board.pickup':
    'Picked up {card}. Available destinations: {destinations}. Use arrow keys to choose a position, then Space or Enter to drop.',
  'ui.board.position': '{card} position {position} of {count} in {column}.',
  'ui.board.drop': 'Moved {card} to {column}, position {position} of {count}.',
  'ui.board.move_failed': 'Could not move {card}. The board was restored.',
  'ui.board.cancel': 'Cancelled moving {card}.',
  'ui.board.unavailable_column': '{column} is unavailable.',
  'ui.board.empty_column': 'No cards in {column}.',
});
