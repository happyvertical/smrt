/**
 * Chat component message catalog (i18n, Sweep S13 #1418).
 *
 * English code defaults for user-facing strings in the chat Svelte components
 * under `tabs/`, `messages/`, and `layout/`. Keys follow
 * `chat.<component>.<descriptor>`.
 */
import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // Helper control panel (#3679)
  'chat.helper.title': 'Helper settings',
  'chat.helper.loading': 'Loading helper settings…',
  'chat.helper.unavailable':
    'Helper settings are unavailable for this application.',
  'chat.helper.gallery': 'Helper gallery',
  'chat.helper.add_style': 'Add {style}',
  'chat.helper.name': 'Display name',
  'chat.helper.voice': 'Voice',
  'chat.helper.placement': 'Placement',
  'chat.helper.bottom_left': 'Bottom left',
  'chat.helper.bottom_right': 'Bottom right',
  'chat.helper.heard_subtitles': 'Show heard subtitles',
  'chat.helper.spoken_subtitles': 'Show spoken subtitles',
  'chat.helper.save': 'Save settings',
  'chat.helper.save_changes': 'Save changes',
  'chat.helper.saving': 'Saving…',
  'chat.helper.unsaved_changes': 'You have unsaved changes.',
  'chat.helper.photo_saved_apply': 'Photo saved. Save settings to use it.',
  'chat.helper.custom_setup': 'Create a photographic helper',
  'chat.helper.back_to_settings': 'Back to helper settings',
  'chat.helper.reset_button': 'Reset to application defaults',
  'chat.helper.saved': 'Helper settings saved.',
  'chat.helper.reset': 'Helper settings reset.',
  'chat.helper.load_failed': 'Could not load helper settings.',
  'chat.helper.save_failed': 'Could not save helper settings.',
  'chat.helper.reset_failed': 'Could not reset helper settings.',
  'chat.helper.open_settings_to_choose':
    'Open Helper settings to choose a saved helper.',
  'chat.helper.selected_style_unavailable':
    'The selected helper style is unavailable.',
  'chat.helper.load_renderer_failed': 'Could not load the selected helper.',
  'chat.helper.preview': 'Selected helper preview',
  'chat.helper.preview_failed': 'Could not preview the selected helper.',
  'chat.helper.opening_assistant':
    'Opening the assistant. Start listening when it is ready.',
  'chat.helper.conversation_unavailable':
    'The assistant could not be opened. Try again before starting listening mode.',
  // ChatLayout
  'chat.chat_layout.rooms_label': 'Chat rooms',
  'chat.chat_layout.resize_sidebar': 'Resize sidebar',

  // MemberList
  'chat.member_list.room_members': 'Room members',
  'chat.member_list.close': 'Close member list',
  'chat.member_list.empty': 'No members',

  // RoomHeader
  'chat.room_header.room_label': 'Room: {name}',
  'chat.room_header.show_members': 'Show members ({count})',
  'chat.room_header.members': 'Members',
  'chat.room_header.search_messages': 'Search messages',
  'chat.room_header.search': 'Search',

  // RoomList
  'chat.room_list.rooms_label': 'Chat rooms',
  'chat.room_list.create_new_room': 'Create new room',
  'chat.room_list.new_room': '+ New Room',
  'chat.room_list.direct_messages': 'Direct Messages',
  'chat.room_list.unread_messages': '{count} unread messages',
  'chat.room_list.no_rooms': 'No rooms yet',
  'chat.room_list.create_first_room': 'Create your first room',

  // MessageInput
  'chat.message_input.cancel_reply': 'Cancel reply',
  'chat.message_input.input_label': 'Message input',
  'chat.message_input.send': 'Send message',

  // MessageItem
  'chat.message_item.message_from': 'Message from {name}',
  'chat.message_item.add_reaction': 'Add reaction',
  'chat.message_item.reply': 'Reply',
  'chat.message_item.edit': 'Edit',
  'chat.message_item.delete': 'Delete',
  'chat.message_item.more_actions': 'Message actions',

  // MessageList
  'chat.message_list.messages_label': 'Messages',
  'chat.message_list.no_messages': 'No messages yet',

  // ThreadPanel
  'chat.thread_panel.thread_label': 'Thread: {title}',
  'chat.thread_panel.close': 'Close thread',
  'chat.thread_panel.reply_placeholder': 'Reply in thread...',

  // ChatTab
  'chat.chat_tab.chat_with': 'Chat with {name}',
  'chat.chat_tab.collapse': 'Collapse chat',
  'chat.chat_tab.minimize': 'Minimize',
  'chat.chat_tab.close': 'Close',
  'chat.chat_tab.open_chat_with': 'Open chat with {name}',
  'chat.chat_tab.unread': '{count} unread',

  // ChatTabList
  'chat.chat_tab_list.minimized_chats': 'Minimized chats',
  'chat.chat_tab_list.open_chat_with': 'Open chat with {name}',
  'chat.chat_tab_list.unread': '{count} unread',
  'chat.chat_tab_list.close_chat_with': 'Close chat with {name}',
  'chat.chat_tab_list.close': 'Close',

  // ChatTabs
  'chat.chat_tabs.tabs_label': 'Chat tabs',

  // MiniChat
  'chat.mini_chat.messages_label': 'Chat messages',
  'chat.mini_chat.no_messages': 'No messages yet',
  'chat.mini_chat.placeholder': 'Type a message...',
  'chat.mini_chat.input_label': 'Message input',
  'chat.mini_chat.send': 'Send message',
});
