/**
 * Chat component message catalog (i18n, Sweep S13 #1418).
 *
 * English code defaults for user-facing strings in the chat Svelte components
 * under `tabs/`, `messages/`, and `layout/`. Keys follow
 * `chat.<component>.<descriptor>`.
 */
import { defineMessages } from '@happyvertical/smrt-svelte/i18n';

export const M = defineMessages({
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
