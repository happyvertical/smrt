/**
 * smrt-svelte `ui`-namespace message catalog (i18n, Sweep S13 #1418).
 *
 * English code defaults for the `ui`, `feedback`, `layout`, `memberships`,
 * `module`, and `calendar` component primitives. Registered through
 * `defineMessages` (see `./registry.ts`); keys follow `<package>.<component>.<descriptor>`
 * with the `ui` namespace for smrt-svelte primitives.
 */

import { defineMessages } from './registry.js';

export const M = defineMessages({
  // calendar/Calendar.svelte
  'ui.calendar.previous_month': 'Previous month',
  'ui.calendar.next_month': 'Next month',
  'ui.calendar.select_month': 'Select month',
  'ui.calendar.select_year': 'Select year',

  // calendar/DayView.svelte
  'ui.day_view.back_to_calendar': 'Back to Calendar',
  'ui.day_view.no_events': 'No events scheduled for this day',

  // feedback/Modal.svelte
  'ui.modal.close': 'Close modal',

  // feedback/ProgressBar.svelte
  'ui.progress_bar.label': 'Progress',
  'ui.progress_bar.over_by': 'Over by {amount}',

  // layout/Footer.svelte
  'ui.footer.all_rights_reserved': 'All rights reserved.',

  // layout/Masthead.svelte
  'ui.masthead.home': 'Home',
  'ui.masthead.primary_nav': 'Primary',
  'ui.masthead.mobile_nav': 'Mobile',

  // memberships/MembershipCard.svelte
  'ui.membership_card.change_role': 'Change Role',

  // memberships/MembershipList.svelte
  'ui.membership_list.loading': 'Loading memberships...',

  // module/ModulePanel.svelte
  'ui.module_panel.component_not_registered': 'Component not registered',
  'ui.module_panel.register_hint':
    "Import the module's Svelte package to register components.",

  // ui/Pagination.svelte
  'ui.pagination.first_page': 'First page',
  'ui.pagination.previous_page': 'Previous page',
  'ui.pagination.page_current': 'Page {page}, current',
  'ui.pagination.go_to_page': 'Go to page {page}',
  'ui.pagination.next_page': 'Next page',
  'ui.pagination.last_page': 'Last page ({totalPages})',
});
