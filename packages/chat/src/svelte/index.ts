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

import { MessageBubble, TypingIndicator } from '@happyvertical/smrt-ui/chat';
import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { CHAT_MODULE_META } from '../ui.js';
// Agent components
import AgentChat from './components/agent/AgentChat.svelte';
import AgentSelector from './components/agent/AgentSelector.svelte';
import AgentSessionPanel from './components/agent/AgentSessionPanel.svelte';
import ToolCallDisplay from './components/agent/ToolCallDisplay.svelte';
import CaptionOverlay from './components/assistant/captions/CaptionOverlay.svelte';
import HeardCaptions from './components/assistant/captions/HeardCaptions.svelte';
import SpokenCaptions from './components/assistant/captions/SpokenCaptions.svelte';
// Dialog components
import RoomCreateDialog from './components/dialogs/RoomCreateDialog.svelte';
import SearchMessages from './components/dialogs/SearchMessages.svelte';
import HelperControlPanel from './components/helper/HelperControlPanel.svelte';
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
// Shared model picker
import ReactionPicker from './components/shared/ReactionPicker.svelte';
import ReadReceipts from './components/shared/ReadReceipts.svelte';
import UserPresence from './components/shared/UserPresence.svelte';
// Tab components
import ChatTab from './components/tabs/ChatTab.svelte';
import ChatTabList from './components/tabs/ChatTabList.svelte';
import ChatTabs from './components/tabs/ChatTabs.svelte';
import MiniChat from './components/tabs/MiniChat.svelte';

// MessageBubble + TypingIndicator are re-exported from the canonical
// `@happyvertical/smrt-ui/chat` primitives (consolidated in #1589);
// ReactionPicker keeps a thin chat-local adapter for the package's i18n + palette.
export { MessageBubble, TypingIndicator } from '@happyvertical/smrt-ui/chat';
// The assistant-turn wire contract (#2908), for hosts writing a transport.
// From the assistant-turn entry: the svelte build only resolves files the
// library build emits as entries (tool-allow-list.ts is bundled into it).
export {
  type AssistantClientToolCall,
  type AssistantClientToolDeclaration,
  type AssistantClientToolResult,
  type AssistantStatus,
  type AssistantStatusState,
  type AssistantTurnEvent,
  type AssistantTurnStep,
  AssistantTurnStreamError,
  matchesToolAllowList,
  readAssistantTurnStream,
} from '../assistant-turn-events.js';
export { default as AgentChat } from './components/agent/AgentChat.svelte';
export { default as AgentSelector } from './components/agent/AgentSelector.svelte';
export { default as AgentSessionPanel } from './components/agent/AgentSessionPanel.svelte';
export { default as ToolCallDisplay } from './components/agent/ToolCallDisplay.svelte';
export { default as AssistantChoiceCards } from './components/assistant/AssistantChoiceCards.svelte';
export { default as AssistantComposer } from './components/assistant/AssistantComposer.svelte';
export { default as AssistantDock } from './components/assistant/AssistantDock.svelte';
export { default as AssistantThreadList } from './components/assistant/AssistantThreadList.svelte';
export {
  ASSISTANT_CHOICE_MAX_OPTIONS,
  ASSISTANT_CHOICE_TOOL_PREFIX,
  type AssistantChoiceOffer,
  type AssistantChoiceOption,
  type AssistantChoicePending,
  type AssistantChoicePendingUpdate,
  type AssistantChoiceSet,
  type AssistantChoiceSource,
  type AssistantChoiceSourceRegistry,
  AssistantChoices,
  choiceToolName,
  createAssistantChoiceSourceRegistry,
  normalizeChoiceOptions,
  safeChoiceImageUrl,
} from './components/assistant/assistant-choices.svelte.js';
// HTTP client half of `@happyvertical/smrt-chat/sveltekit`'s
// `mountAssistantRoutes` (#3368).
export {
  type AssistantHttpActionClientOptions,
  AssistantHttpError,
  type AssistantHttpOptions,
  type AssistantHttpTransportOptions,
  createAssistantHttpActionClient,
  createAssistantHttpTransport,
} from './components/assistant/assistant-http-client.js';
export {
  type AssistantAttachmentRef,
  type AssistantMessage,
  type AssistantResumeTurnInput,
  type AssistantSendMessageInput,
  type AssistantSendMessageResult,
  type AssistantThreadSummary,
  type AssistantTransport,
  type AssistantTransportEvent,
  type AssistantTurnStreamInput,
  createInMemoryAssistantTransport,
  createSmrtAssistantTransport,
  type FullAssistantTransport,
  type InMemoryAssistantTransportOptions,
  readAssistantTurnResult,
  type SmrtAssistantTransportOptions,
} from './components/assistant/assistant-transport.js';
export { default as CaptionOverlay } from './components/assistant/captions/CaptionOverlay.svelte';
export {
  type CaptionChannel,
  type CaptionChannelOptions,
  type CaptionLine,
  type CaptionTTSAdapter,
  createCaptionChannel,
  createHeardCaptionCallbacks,
  createSpokenCaptionCallbacks,
  createSpokenCaptionSession,
  type SpokenCaptionCallbacks,
  type SpokenCaptionSession,
} from './components/assistant/captions/caption-state.svelte.js';
export { default as HeardCaptions } from './components/assistant/captions/HeardCaptions.svelte';
export { default as SpokenCaptions } from './components/assistant/captions/SpokenCaptions.svelte';
export {
  ASSISTANT_PROPOSE_ACTION_TOOL,
  type AssistantClientTool,
  type AssistantClientToolPolicy,
  type AssistantClientToolSource,
  type AssistantToolRequest,
  declareClientTools,
  defaultClientToolPolicy,
  resolveClientToolPolicy,
} from './components/assistant/client-tools.js';
export {
  ASSISTANT_ACTION_UNKNOWN_OUTCOME_REASONS,
  type AssistantActionClient,
  type AssistantActionOutcome,
  type AssistantActionState,
  type AssistantDockController,
  type AssistantDockControllerOptions,
  type AssistantPendingSend,
  type AssistantPendingSendStatus,
  type AssistantRun,
  type AssistantRunState,
  type AssistantRunStopReason,
  type AssistantRunWaiting,
  type AssistantUserHold,
  createAssistantDockController,
} from './components/assistant/create-assistant-dock-controller.svelte.js';
export {
  default as FloatingAssistant,
  type FloatingAssistantPresentationState,
} from './components/assistant/FloatingAssistant.svelte';
export { default as RoomCreateDialog } from './components/dialogs/RoomCreateDialog.svelte';
export { default as SearchMessages } from './components/dialogs/SearchMessages.svelte';
export { default as HelperControlPanel } from './components/helper/HelperControlPanel.svelte';
export {
  createHappyHelperStyle,
  createHelperStyleRegistry,
  createPhotoCutoutHelperStyle,
  HAPPY_HELPER_OFFERING,
  type HappyHelperStyleOptions,
  type HappyRuntime,
  type HelperRendererHandle,
  type HelperStyleDefinition,
  type HelperStyleMountInput,
  type HelperStyleRegistry,
  type HelperStyleSetupProps,
  type PhotoCutoutPayload,
} from './components/helper/registry.js';
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
export type { ModelOption } from './components/shared/ModelPicker.svelte';
export { default as ModelPicker } from './components/shared/ModelPicker.svelte';
export { default as ReactionPicker } from './components/shared/ReactionPicker.svelte';
export { default as ReadReceipts } from './components/shared/ReadReceipts.svelte';
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
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'heard-captions',
  HeardCaptions,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'spoken-captions',
  SpokenCaptions,
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

ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'caption-overlay',
  CaptionOverlay,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-chat',
  'helper-control-panel',
  HelperControlPanel,
);
