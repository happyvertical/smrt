/** English defaults for the provider-backed notification bell. */
import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  'ui.notification_bell.label': 'Notifications',
  'ui.notification_bell.unread': '{count} unread',
  'ui.notification_bell.mark_all': 'Mark all read',
  'ui.notification_bell.mark_one': 'Mark read',
  'ui.notification_bell.loading': 'Loading notifications',
  'ui.notification_bell.empty': 'No notifications.',
  'ui.notification_bell.unavailable': 'Notifications are unavailable.',
  'ui.notification_bell.mark_error': 'Could not mark notifications read.',
  'ui.notification_bell.live_error': 'Live notifications are unavailable.',
});
