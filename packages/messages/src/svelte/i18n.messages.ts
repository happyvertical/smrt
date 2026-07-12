/**
 * Messages component message catalog (i18n, Sweep S13 #1418).
 *
 * English code defaults for user-facing strings in a subset of the messages
 * Svelte components under `components/`. Keys follow
 * `messages.<component>.<descriptor>`.
 */
import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // MessageStatusIndicator
  'messages.message_status_indicator.status': 'Message status',
  'messages.message_status_indicator.unread': 'Unread',
  'messages.message_status_indicator.flagged': 'Flagged',
  'messages.message_status_indicator.has_attachments': 'Has attachments',
  'messages.message_status_indicator.replied': 'Replied',
  'messages.message_status_indicator.draft': 'Draft',

  // MessageFilters
  'messages.message_filters.filters_label': 'Message filters',
  'messages.message_filters.search_placeholder': 'Search messages...',
  'messages.message_filters.search_label': 'Search messages',
  'messages.message_filters.filter_by_type': 'Filter by type',
  'messages.message_filters.all_types': 'All types',
  'messages.message_filters.filter_by_account': 'Filter by account',
  'messages.message_filters.all_accounts': 'All accounts',
  'messages.message_filters.filter_by_read_status': 'Filter by read status',
  'messages.message_filters.unread_only': 'Unread only',
  'messages.message_filters.read_only': 'Read only',
  'messages.message_filters.clear_filters': 'Clear filters',

  // MessageList
  'messages.message_list.messages_label': 'Messages',
  'messages.message_list.loading': 'Loading messages...',

  // MessageToolbar
  'messages.message_toolbar.actions_label': 'Message actions',
  'messages.message_toolbar.count_selected':
    '{selectedCount} of {totalCount} selected',
  'messages.message_toolbar.select_all': 'Select all',
  'messages.message_toolbar.mark_read': 'Mark read',
  'messages.message_toolbar.mark_unread': 'Mark unread',

  // ThreadView
  'messages.thread_view.conversation_thread': 'Conversation thread',
  'messages.thread_view.collapse': 'Collapse',
  'messages.thread_view.collapse_message': 'Collapse message',

  // MessageCard
  'messages.message_card.select_message': 'Select message',

  // FolderNav
  'messages.folder_nav.folders': 'Folders',

  // MessagingSettingsPanel
  'messages.messaging_settings.accounts_title': 'Sending accounts',
  'messages.messaging_settings.accounts_description':
    'Provider credentials used by this tenant.',
  'messages.messaging_settings.add_account': 'Add account',
  'messages.messaging_settings.credentials_stored': 'Credentials stored',
  'messages.messaging_settings.credentials_missing': 'Credentials missing',
  'messages.messaging_settings.no_accounts': 'No sending accounts configured.',
  'messages.messaging_settings.destinations_title': 'Destinations',
  'messages.messaging_settings.destinations_description':
    'Write-only addresses where this persona may contact you.',
  'messages.messaging_settings.add_destination': 'Add destination',
  'messages.messaging_settings.no_destinations': 'No destinations configured.',
  'messages.messaging_settings.routes_title': 'Persona routes',
  'messages.messaging_settings.routes_description':
    'Bind this persona to an account and destination.',
  'messages.messaging_settings.add_route': 'Add route',
  'messages.messaging_settings.no_routes':
    'No routes configured for this persona.',
  'messages.messaging_settings.priority_value': 'Priority {priority}',
  'messages.messaging_settings.missing_account': 'Missing account',
  'messages.messaging_settings.missing_destination': 'Missing destination',
  'messages.messaging_settings.edit_account_title': 'Edit sending account',
  'messages.messaging_settings.add_account_title': 'Add sending account',
  'messages.messaging_settings.name': 'Name',
  'messages.messaging_settings.provider': 'Provider',
  'messages.messaging_settings.select': 'Select…',
  'messages.messaging_settings.credentials': 'Credentials',
  'messages.messaging_settings.credentials_note':
    'Stored credentials are never displayed. Leave these blank to keep them unchanged.',
  'messages.messaging_settings.account_active': 'Account active',
  'messages.messaging_settings.cancel': 'Cancel',
  'messages.messaging_settings.save_account': 'Save account',
  'messages.messaging_settings.replace_destination_title':
    'Replace destination',
  'messages.messaging_settings.add_destination_title': 'Add destination',
  'messages.messaging_settings.destination_note':
    'The current address is not readable. Saving replaces it with the values below.',
  'messages.messaging_settings.label': 'Label',
  'messages.messaging_settings.destination_active': 'Destination active',
  'messages.messaging_settings.save_destination': 'Save destination',
  'messages.messaging_settings.edit_route_title': 'Edit persona route',
  'messages.messaging_settings.add_route_title': 'Add persona route',
  'messages.messaging_settings.sending_account': 'Sending account',
  'messages.messaging_settings.destination': 'Destination',
  'messages.messaging_settings.purpose': 'Purpose',
  'messages.messaging_settings.priority': 'Priority',
  'messages.messaging_settings.route_enabled': 'Route enabled',
  'messages.messaging_settings.save_route': 'Save route',
});
