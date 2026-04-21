/**
 * Messages Module UI Slot Declarations
 *
 * Defines UI extension points for the messages module.
 * UI components are implemented in the ./svelte subpath.
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import './__smrt-register__.js';

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

export const MESSAGES_UI_SLOTS: Record<string, ModuleUISlot> = {
  'message-card': {
    id: 'message-card',
    label: 'Message Card',
    description: 'Single message row with type-adaptive rendering',
    icon: 'mail',
    category: 'display',
    order: 1,
    propsInterface: 'MessageCardProps',
  },
  'message-list': {
    id: 'message-list',
    label: 'Message List',
    description: 'Unified message list with selection and filtering',
    icon: 'list',
    category: 'list',
    order: 2,
    propsInterface: 'MessageListProps',
  },
  'message-detail': {
    id: 'message-detail',
    label: 'Message Detail',
    description: 'Full message view with type-adaptive sections',
    icon: 'file-text',
    category: 'display',
    order: 3,
    propsInterface: 'MessageDetailProps',
  },
  'message-filters': {
    id: 'message-filters',
    label: 'Message Filters',
    description: 'Filter and sort controls for message lists',
    icon: 'filter',
    category: 'action',
    order: 4,
    propsInterface: 'MessageFiltersProps',
  },
  'account-list': {
    id: 'account-list',
    label: 'Account List',
    description: 'Account management list with sync status',
    icon: 'users',
    category: 'list',
    order: 5,
    propsInterface: 'AccountListProps',
  },
  'thread-view': {
    id: 'thread-view',
    label: 'Thread View',
    description: 'Conversation thread with collapsible messages',
    icon: 'message-circle',
    category: 'display',
    order: 6,
    propsInterface: 'ThreadViewProps',
  },
  'compose-form': {
    id: 'compose-form',
    label: 'Compose Form',
    description: 'Full message compose form with type-adaptive fields',
    icon: 'edit',
    category: 'action',
    order: 7,
    propsInterface: 'ComposeFormProps',
  },
  'reply-form': {
    id: 'reply-form',
    label: 'Reply Form',
    description: 'Inline reply form with quoted original',
    icon: 'reply',
    category: 'action',
    order: 8,
    propsInterface: 'ReplyFormProps',
  },
};

export const MESSAGES_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-messages',
  displayName: 'Messages',
  description:
    'Unified multi-channel messaging: email, Slack, Twitter, and more',
  uiSlots: MESSAGES_UI_SLOTS,
  models: [
    'Message',
    'Email',
    'Tweet',
    'SlackMessage',
    'Account',
    'EmailAccount',
    'SlackAccount',
    'TwitterAccount',
    'Attachment',
  ],
  collections: [
    'MessageCollection',
    'EmailCollection',
    'AccountCollection',
    'EmailAccountCollection',
    'AttachmentCollection',
  ],
};
