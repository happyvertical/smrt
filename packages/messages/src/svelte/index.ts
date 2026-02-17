/**
 * Messages Module Svelte Components
 *
 * Optional Svelte UI components for multi-channel messaging.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import { MESSAGES_MODULE_META } from '../ui.js';

// Import components
import AccountAvatar from './components/AccountAvatar.svelte';
import AccountCard from './components/AccountCard.svelte';
import AccountList from './components/AccountList.svelte';
import AttachmentChip from './components/AttachmentChip.svelte';
import AttachmentUpload from './components/AttachmentUpload.svelte';
import ComposeForm from './components/ComposeForm.svelte';
import FolderNav from './components/FolderNav.svelte';
import ForwardForm from './components/ForwardForm.svelte';
import MessageCard from './components/MessageCard.svelte';
import MessageDetail from './components/MessageDetail.svelte';
import MessageFilters from './components/MessageFilters.svelte';
import MessageList from './components/MessageList.svelte';
import MessageStatusIndicator from './components/MessageStatusIndicator.svelte';
import MessageToolbar from './components/MessageToolbar.svelte';
import MessageTypeBadge from './components/MessageTypeBadge.svelte';
import RecipientInput from './components/RecipientInput.svelte';
import ReplyForm from './components/ReplyForm.svelte';
import SendStatusBadge from './components/SendStatusBadge.svelte';
import ThreadView from './components/ThreadView.svelte';

// Export components
export {
  AccountAvatar,
  AccountCard,
  AccountList,
  AttachmentChip,
  AttachmentUpload,
  ComposeForm,
  FolderNav,
  ForwardForm,
  MessageCard,
  MessageDetail,
  MessageFilters,
  MessageList,
  MessageStatusIndicator,
  MessageToolbar,
  MessageTypeBadge,
  RecipientInput,
  ReplyForm,
  SendStatusBadge,
  ThreadView,
};

// Export component prop types
export type { Props as AccountAvatarProps } from './components/AccountAvatar.svelte';
export type { Props as AccountCardProps } from './components/AccountCard.svelte';
export type { Props as AccountListProps } from './components/AccountList.svelte';
export type { Props as AttachmentChipProps } from './components/AttachmentChip.svelte';
export type { Props as AttachmentUploadProps } from './components/AttachmentUpload.svelte';
export type { Props as ComposeFormProps } from './components/ComposeForm.svelte';
export type { Props as FolderNavProps } from './components/FolderNav.svelte';
export type { Props as ForwardFormProps } from './components/ForwardForm.svelte';
export type { Props as MessageCardProps } from './components/MessageCard.svelte';
export type { Props as MessageDetailProps } from './components/MessageDetail.svelte';
export type { Props as MessageFiltersProps } from './components/MessageFilters.svelte';
export type { Props as MessageListProps } from './components/MessageList.svelte';
export type { Props as MessageStatusIndicatorProps } from './components/MessageStatusIndicator.svelte';
export type { Props as MessageToolbarProps } from './components/MessageToolbar.svelte';
export type { Props as MessageTypeBadgeProps } from './components/MessageTypeBadge.svelte';
export type { Props as RecipientInputProps } from './components/RecipientInput.svelte';
export type { Props as ReplyFormProps } from './components/ReplyForm.svelte';
export type { Props as SendStatusBadgeProps } from './components/SendStatusBadge.svelte';
export type { Props as ThreadViewProps } from './components/ThreadView.svelte';

// Export shared types
export type {
  AccountData,
  AttachmentData,
  BulkAction,
  ComposeState,
  DraftData,
  FolderData,
  MessageData,
  MessageFilterState,
  MessageSort,
  MessageType,
  RecipientEntry,
  SendStatusDisplay,
} from './types.js';

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(MESSAGES_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-messages',
  'message-card',
  MessageCard,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-messages',
  'message-list',
  MessageList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-messages',
  'message-detail',
  MessageDetail,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-messages',
  'message-filters',
  MessageFilters,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-messages',
  'account-list',
  AccountList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-messages',
  'thread-view',
  ThreadView,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-messages',
  'compose-form',
  ComposeForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-messages',
  'reply-form',
  ReplyForm,
);
