import type { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n/strings.sortable.js';
import type { SortableAnnouncement } from './controller.svelte.js';

/** Localized screen-reader text for a sortable engine announcement. */
export function formatSortableAnnouncement(
  t: ReturnType<typeof useI18n>['t'],
  announcement: SortableAnnouncement,
): string {
  switch (announcement.type) {
    case 'pickup':
      return t(M['ui.sortable.pickup'], {
        item: announcement.item,
        destinations: announcement.destinations.join(', '),
      });
    case 'position':
      return t(M['ui.sortable.position'], {
        item: announcement.item,
        container: announcement.container,
        position: announcement.position,
        count: announcement.count,
      });
    case 'drop':
      return t(M['ui.sortable.drop'], {
        item: announcement.item,
        container: announcement.container,
        position: announcement.position,
        count: announcement.count,
      });
    case 'unavailable':
      return t(M['ui.sortable.unavailable'], {
        container: announcement.container,
      });
    case 'failed':
      return t(M['ui.sortable.failed'], { item: announcement.item });
    case 'cancel':
      return t(M['ui.sortable.cancel'], { item: announcement.item });
  }
}
