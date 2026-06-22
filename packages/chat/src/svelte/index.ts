/**
 * Chat Svelte Components
 *
 * This module auto-registers all chat UI components with the ModuleUIRegistry
 * when imported. Import this module to enable registry-based component discovery.
 *
 * @example Direct imports
 * ```typescript
 * import { ChatLayout, MessageList, MessageInput } from '@happyvertical/smrt-chat/svelte';
 * ```
 *
 * @example Registry-based discovery
 * ```typescript
 * import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
 * import '@happyvertical/smrt-chat/svelte'; // Auto-registers components
 *
 * const Component = ModuleUIRegistry.get('@happyvertical/smrt-chat', 'chat-layout');
 * ```
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { CHAT_MODULE_META } from '../ui.js';
// Agent components
import AgentChat from './components/agent/AgentChat.svelte';
import AgentSelector from './components/agent/AgentSelector.svelte';
import AgentSessionPanel from './components/agent/AgentSessionPanel.svelte';
import ToolCallDisplay from './components/agent/ToolCallDisplay.svelte';
// Dialog components
import RoomCreateDialog from './components/dialogs/RoomCreateDialog.svelte';
import SearchMessages from './components/dialogs/SearchMessages.svelte';
// Layout components
import ChatLayout from './components/layout/ChatLayout.svelte';
import MemberList from './components/layout/MemberList.svelte';
import RoomHeader from './components/layout/RoomHeader.svelte';
import RoomList from './components/layout/RoomList.svelte';
// Message components
import MessageInput from './components/messages/MessageInput.svelte';
import MessageItem from './components/messages/MessageItem.svelte';
import MessageList from './components/messages/MessageList.svelte';
import ThreadPanel from './components/messages/ThreadPanel.svelte';
// Shared components
import Avatar from './components/shared/Avatar.svelte';
import FileUpload from './components/shared/FileUpload.svelte';
import LinkPreview from './components/shared/LinkPreview.svelte';
import MentionAutocomplete from './components/shared/MentionAutocomplete.svelte';
import MessageBubble from './components/shared/MessageBubble.svelte';
import ReactionPicker from './components/shared/ReactionPicker.svelte';
import ReadReceipts from './components/shared/ReadReceipts.svelte';
import TypingIndicator from './components/shared/TypingIndicator.svelte';
import UserPresence from './components/shared/UserPresence.svelte';
// Tab components
import ChatTab from './components/tabs/ChatTab.svelte';
import ChatTabList from './components/tabs/ChatTabList.svelte';
import ChatTabs from './components/tabs/ChatTabs.svelte';
import MiniChat from './components/tabs/MiniChat.svelte';

export { default as AgentChat } from './components/agent/AgentChat.svelte';
export { default as AgentSelector } from './components/agent/AgentSelector.svelte';
export { default as AgentSessionPanel } from './components/agent/AgentSessionPanel.svelte';
export { default as ToolCallDisplay } from './components/agent/ToolCallDisplay.svelte';
export { default as RoomCreateDialog } from './components/dialogs/RoomCreateDialog.svelte';
export { default as SearchMessages } from './components/dialogs/SearchMessages.svelte';
// Export components
export { default as ChatLayout } from './components/layout/ChatLayout.svelte';
export { default as MemberList } from './components/layout/MemberList.svelte';
export { default as RoomHeader } from './components/layout/RoomHeader.svelte';
export { default as RoomList } from './components/layout/RoomList.svelte';
export { default as MessageInput } from './components/messages/MessageInput.svelte';
export { default as MessageItem } from './components/messages/MessageItem.svelte';
export { default as MessageList } from './components/messages/MessageList.svelte';
export { default as ThreadPanel } from './components/messages/ThreadPanel.svelte';
export { default as Avatar } from './components/shared/Avatar.svelte';
export { default as FileUpload } from './components/shared/FileUpload.svelte';
export { default as LinkPreview } from './components/shared/LinkPreview.svelte';
export { default as MentionAutocomplete } from './components/shared/MentionAutocomplete.svelte';
export { default as MessageBubble } from './components/shared/MessageBubble.svelte';
export { default as ReactionPicker } from './components/shared/ReactionPicker.svelte';
export { default as ReadReceipts } from './components/shared/ReadReceipts.svelte';
export { default as TypingIndicator } from './components/shared/TypingIndicator.svelte';
export { default as UserPresence } from './components/shared/UserPresence.svelte';
export { default as ChatTab } from './components/tabs/ChatTab.svelte';
export { default as ChatTabList } from './components/tabs/ChatTabList.svelte';
export { default as ChatTabs } from './components/tabs/ChatTabs.svelte';
export { default as MiniChat } from './components/tabs/MiniChat.svelte';

// Export types
export type {
  AgentDescriptor,
  AgentSessionData,
  ChatAttachmentData,
  ChatMessageData,
  ChatParticipantData,
  ChatRoomData,
  ChatTabState,
  ChatThreadData,
  ReactionSummary,
  ToolCallDisplayData,
} from './types.js';

// Auto-register module and components with ModuleUIRegistry
ModuleUIRegistry.registerModule(CHAT_MODULE_META);

// Layout
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'chat-layout',
  ChatLayout,
);
ModuleUIRegistry.register('@happyvertical/smrt-chat', 'room-list', RoomList);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'room-header',
  RoomHeader,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'member-list',
  MemberList,
);

// Messages
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'message-list',
  MessageList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'message-item',
  MessageItem,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'message-input',
  MessageInput,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'thread-panel',
  ThreadPanel,
);

// Tabs
ModuleUIRegistry.register('@happyvertical/smrt-chat', 'chat-tabs', ChatTabs);
ModuleUIRegistry.register('@happyvertical/smrt-chat', 'chat-tab', ChatTab);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'chat-tab-list',
  ChatTabList,
);
ModuleUIRegistry.register('@happyvertical/smrt-chat', 'mini-chat', MiniChat);

// Agent
ModuleUIRegistry.register('@happyvertical/smrt-chat', 'agent-chat', AgentChat);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'agent-selector',
  AgentSelector,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'agent-session-panel',
  AgentSessionPanel,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'tool-call-display',
  ToolCallDisplay,
);

// Shared
ModuleUIRegistry.register('@happyvertical/smrt-chat', 'avatar', Avatar);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'file-upload',
  FileUpload,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'link-preview',
  LinkPreview,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'mention-autocomplete',
  MentionAutocomplete,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'message-bubble',
  MessageBubble,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'reaction-picker',
  ReactionPicker,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'read-receipts',
  ReadReceipts,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'typing-indicator',
  TypingIndicator,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'user-presence',
  UserPresence,
);

// Dialogs
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'room-create-dialog',
  RoomCreateDialog,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'search-messages',
  SearchMessages,
);
