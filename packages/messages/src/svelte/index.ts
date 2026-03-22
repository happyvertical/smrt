/**
 * Messages Module Svelte Components
 *
 * Optional Svelte UI components for multi-channel messaging.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import type { ComponentProps } from 'svelte';
import { MESSAGES_MODULE_META } from '../ui.js';

// Import components
import AccountAvatar from './components/AccountAvatar.svelte';
import AccountCard from './components/AccountCard.svelte';
import AccountList from './components/AccountList.svelte';
import AttachmentChip from './components/AttachmentChip.svelte';
import AttachmentUpload from './components/AttachmentUpload.svelte';
import ComposeForm from './components/ComposeForm.svelte';
import EmailAccountManager from './components/EmailAccountManager.svelte';
import EmailFilterManager from './components/EmailFilterManager.svelte';
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
  EmailAccountManager,
  EmailFilterManager,
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
export type AccountAvatarProps = ComponentProps<typeof AccountAvatar>;
export type AccountCardProps = ComponentProps<typeof AccountCard>;
export type AccountListProps = ComponentProps<typeof AccountList>;
export type AttachmentChipProps = ComponentProps<typeof AttachmentChip>;
export type AttachmentUploadProps = ComponentProps<typeof AttachmentUpload>;
export type ComposeFormProps = ComponentProps<typeof ComposeForm>;
export type EmailAccountManagerProps = ComponentProps<
  typeof EmailAccountManager
>;
export type EmailFilterManagerProps = ComponentProps<typeof EmailFilterManager>;
export type FolderNavProps = ComponentProps<typeof FolderNav>;
export type ForwardFormProps = ComponentProps<typeof ForwardForm>;
export type MessageCardProps = ComponentProps<typeof MessageCard>;
export type MessageDetailProps = ComponentProps<typeof MessageDetail>;
export type MessageFiltersProps = ComponentProps<typeof MessageFilters>;
export type MessageListProps = ComponentProps<typeof MessageList>;
export type MessageStatusIndicatorProps = ComponentProps<
  typeof MessageStatusIndicator
>;
export type MessageToolbarProps = ComponentProps<typeof MessageToolbar>;
export type MessageTypeBadgeProps = ComponentProps<typeof MessageTypeBadge>;
export type RecipientInputProps = ComponentProps<typeof RecipientInput>;
export type ReplyFormProps = ComponentProps<typeof ReplyForm>;
export type SendStatusBadgeProps = ComponentProps<typeof SendStatusBadge>;
export type ThreadViewProps = ComponentProps<typeof ThreadView>;

// Export shared types
export type {
  AccountData,
  AttachmentData,
  BlacklistEntry,
  BulkAction,
  ComposeState,
  DraftData,
  EmailAccountData,
  FolderData,
  MessageData,
  MessageFilterState,
  MessageSort,
  MessageType,
  RecipientEntry,
  SendStatusDisplay,
  WhitelistEntry,
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
