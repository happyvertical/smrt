/**
 * Messages component message catalog (i18n, Sweep S13 #1418).
 *
 * English code defaults for user-facing strings in a subset of the messages
 * Svelte components under `components/`. Keys follow
 * `messages.<component>.<descriptor>`.
 */
import { defineMessages } from '@happyvertical/smrt-svelte/i18n';

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
});
