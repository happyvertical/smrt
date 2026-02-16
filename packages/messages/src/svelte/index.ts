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
import FolderNav from './components/FolderNav.svelte';
import MessageCard from './components/MessageCard.svelte';
import MessageDetail from './components/MessageDetail.svelte';
import MessageFilters from './components/MessageFilters.svelte';
import MessageList from './components/MessageList.svelte';
import MessageStatusIndicator from './components/MessageStatusIndicator.svelte';
import MessageToolbar from './components/MessageToolbar.svelte';
import MessageTypeBadge from './components/MessageTypeBadge.svelte';
import ThreadView from './components/ThreadView.svelte';

// Export components
export {
  AccountAvatar,
  AccountCard,
  AccountList,
  AttachmentChip,
  FolderNav,
  MessageCard,
  MessageDetail,
  MessageFilters,
  MessageList,
  MessageStatusIndicator,
  MessageToolbar,
  MessageTypeBadge,
  ThreadView,
};

// Export component prop types
export type { Props as AccountAvatarProps } from './components/AccountAvatar.svelte';
export type { Props as AccountCardProps } from './components/AccountCard.svelte';
export type { Props as AccountListProps } from './components/AccountList.svelte';
export type { Props as AttachmentChipProps } from './components/AttachmentChip.svelte';
export type { Props as FolderNavProps } from './components/FolderNav.svelte';
export type { Props as MessageCardProps } from './components/MessageCard.svelte';
export type { Props as MessageDetailProps } from './components/MessageDetail.svelte';
export type { Props as MessageFiltersProps } from './components/MessageFilters.svelte';
export type { Props as MessageListProps } from './components/MessageList.svelte';
export type { Props as MessageStatusIndicatorProps } from './components/MessageStatusIndicator.svelte';
export type { Props as MessageToolbarProps } from './components/MessageToolbar.svelte';
export type { Props as MessageTypeBadgeProps } from './components/MessageTypeBadge.svelte';
export type { Props as ThreadViewProps } from './components/ThreadView.svelte';

// Export shared types
export type {
  AccountData,
  AttachmentData,
  BulkAction,
  FolderData,
  MessageData,
  MessageFilterState,
  MessageSort,
  MessageType,
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
