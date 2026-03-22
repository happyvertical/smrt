import { MESSAGES_MODULE_META } from '../ui.js';

const noop = () => {};

const sampleAccounts = [
  {
    id: 'account-editorial',
    name: 'Editorial Inbox',
    email: 'editorial@example.com',
    providerType: 'email',
    isActive: true,
    unreadCount: 12,
    totalCount: 438,
    lastSyncAt: '2026-03-21T16:12:00.000Z',
  },
  {
    id: 'account-social',
    name: 'Community Slack',
    providerType: 'slack',
    isActive: true,
    unreadCount: 3,
    totalCount: 91,
    lastSyncAt: '2026-03-21T16:05:00.000Z',
  },
];

const sampleAttachments = [
  {
    id: 'attachment-proof',
    filename: 'proofing-notes.pdf',
    contentType: 'application/pdf',
    size: 248512,
  },
];

const sampleMessages = [
  {
    id: 'message-1',
    type: 'email',
    accountId: 'account-editorial',
    subject: 'Governance review complete',
    body: 'The editorial governance review is complete and the draft is ready for publication.',
    senderName: 'Taylor Rowan',
    senderAddress: 'taylor@example.com',
    recipientAddresses: [
      { address: 'editorial@example.com', name: 'Editorial Desk' },
    ],
    ccAddresses: [{ address: 'governance@example.com', name: 'Governance' }],
    threadId: 'thread-1',
    isRead: true,
    isFlagged: false,
    hasAttachments: true,
    attachments: sampleAttachments,
    date: '2026-03-21T15:30:00.000Z',
    folderPath: 'Inbox',
    labels: ['governance', 'release'],
    sendStatus: 'sent',
  },
  {
    id: 'message-2',
    type: 'slack',
    accountId: 'account-social',
    subject: 'Release coordination',
    body: 'Can we confirm the package rollout order for this afternoon?',
    senderName: 'Jordan Lee',
    senderAddress: 'jordan@example.com',
    recipientAddresses: [{ address: '#release-coordination' }],
    isRead: false,
    isFlagged: true,
    hasAttachments: false,
    date: '2026-03-21T16:02:00.000Z',
    folderPath: 'Slack / release-coordination',
    meta: {
      channelName: 'release-coordination',
    },
  },
];

const loadAccountList = () => import('./components/AccountList.svelte');
const loadComposeForm = () => import('./components/ComposeForm.svelte');
const loadMessageDetail = () => import('./components/MessageDetail.svelte');
const loadMessageList = () => import('./components/MessageList.svelte');

export default {
  packageName: '@happyvertical/smrt-messages',
  displayName: MESSAGES_MODULE_META.displayName,
  description: MESSAGES_MODULE_META.description,
  moduleMeta: MESSAGES_MODULE_META,
  entries: [
    {
      id: 'account-list',
      title: 'Account List',
      description:
        'Connected messaging accounts with sync state and unread counts.',
      loadComponent: loadAccountList,
      order: 1,
      props: {
        accounts: sampleAccounts,
        onaccountclick: noop,
        onsync: noop,
        onremove: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'message-list',
      title: 'Message List',
      description:
        'Inbox-style message listing with selection, account context, and type-aware cards.',
      loadComponent: loadMessageList,
      order: 2,
      props: {
        messages: sampleMessages,
        activeMessageId: 'message-1',
        accounts: sampleAccounts,
        showAccount: true,
        onmessageclick: noop,
        onselect: noop,
        onflag: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'message-detail',
      title: 'Message Detail',
      description:
        'Full message view for reading, attachments, and follow-up actions.',
      loadComponent: loadMessageDetail,
      order: 3,
      props: {
        message: sampleMessages[0],
        attachments: sampleAttachments,
        account: sampleAccounts[0],
        onreply: noop,
        onforward: noop,
        ondelete: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'compose-form',
      title: 'Compose Form',
      description:
        'Channel-aware compose experience for email, Slack, and short-form posts.',
      loadComponent: loadComposeForm,
      order: 4,
      props: {
        type: 'email',
        accounts: sampleAccounts,
        initialState: {
          accountId: 'account-editorial',
          to: [
            { address: 'ops@example.com', name: 'Operations', isValid: true },
          ],
          subject: 'Launch checklist follow-up',
          body: 'Please confirm the remaining package rollout items for issue #1047.',
        },
        onsend: noop,
        onsavedraft: noop,
        ondiscard: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
