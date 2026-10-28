import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Email } from './models/Email.js';
import { EmailAccount } from './models/EmailAccount.js';
import { SlackAccount } from './models/SlackAccount.js';
import { SlackMessage } from './models/SlackMessage.js';
import { UserNotification } from './models/UserNotification.js';

/** Email reading and composing with application-owned transport. */
export class MailboxRecipe extends SmrtRecipe {
  static id = 'messages.mailbox';
  static label = 'Mailbox';
  static summary = 'Read and compose email from your connected accounts.';
  static synonyms = ['email', 'inbox', 'mail'];
  static group = {
    id: 'messages',
    label: 'Messaging',
    summary: 'Choose email and personal updates independently.',
  };
  static section = {
    id: 'messages',
    label: 'Messaging',
    icon: 'folder',
    description: 'Read email and keep up with updates addressed to you.',
  };
  static models = [Email, EmailAccount];
  static runtime = 'both' as const;
  static surfaces = [
    {
      kind: 'route',
      path: '/messages/mailbox',
      export: '@happyvertical/smrt-messages/svelte#MessageList',
      label: 'Mailbox',
    },
    {
      kind: 'playground',
      export: '@happyvertical/smrt-messages/svelte#MailboxDemo',
      label: 'Mailbox with mocked sending',
    },
  ] as const;
  static providers = [
    {
      id: 'email-inbox',
      kind: 'email',
      options: ['imap', 'pop3', 'gmail'],
      required: true,
    },
    {
      id: 'email-send',
      kind: 'email',
      options: ['smtp', 'gmail'],
      required: false,
    },
  ];
  static demoSeed = {
    data: {
      accounts: [
        {
          id: 'demo-account',
          name: 'Demo Inbox',
          providerType: 'email',
          email: 'you@example.com',
          isActive: true,
        },
      ],
      messages: [
        {
          id: 'demo-welcome',
          type: 'email',
          accountId: 'demo-account',
          subject: 'Welcome to your mailbox',
          body: 'Fictional mail. Sending is mocked; nothing leaves this browser.',
          senderName: 'Demo colleague',
          senderAddress: 'colleague@example.com',
          recipientAddresses: [{ address: 'you@example.com' }],
          date: '2026-01-01T12:00:00Z',
          isRead: false,
          isFlagged: false,
          hasAttachments: false,
        },
      ],
    },
  };
  static nav = [
    {
      label: 'Mailbox',
      model: Email,
      key: 'mailbox',
      icon: 'folder',
      noun: 'email',
      description: 'Read email from your connected accounts.',
    },
    {
      label: 'Failed sends',
      model: Email,
      key: 'failed-sends',
      icon: 'fileText',
      noun: 'email',
      description: 'Review email whose last send attempt failed.',
      filter: { field: 'sendStatus', value: 'failed' },
    },
  ];
  static help = './help/mailbox.md';
  static options = {
    Email: {
      fields: {
        created_at: { help: 'When this email was first recorded.' },
        updated_at: { help: 'When this email record was last changed.' },
      },
    },
    EmailAccount: {
      fields: {
        created_at: {
          help: 'When this mailbox connection was first recorded.',
        },
        updated_at: { help: 'When this mailbox connection was last changed.' },
      },
    },
  } as const;
}

/** Recipient-scoped in-app notification bell. */
export class NotificationsRecipe extends SmrtRecipe {
  static id = 'messages.notifications';
  static label = 'Notifications';
  static summary = 'See updates addressed to you and mark them read.';
  static synonyms = ['alerts', 'notification bell'];
  static group = {
    id: 'messages',
    label: 'Messaging',
    summary: 'Choose email and personal updates independently.',
  };
  static section = {
    id: 'messages',
    label: 'Messaging',
    icon: 'folder',
    description: 'Read email and keep up with updates addressed to you.',
  };
  static models = [UserNotification];
  static runtime = 'both' as const;
  static surfaces = [
    {
      kind: 'shell-widget',
      slot: 'header.end',
      export: '@happyvertical/smrt-svelte/notifications#NotificationBell',
      label: 'Notifications',
    },
  ] as const;
  static providers = [
    {
      id: 'notifications',
      kind: 'notifications',
      options: ['user-notification-service'],
      required: true,
    },
  ];
  static demoSeed = {
    data: {
      items: [
        {
          id: 'demo-notification',
          title: 'You were mentioned',
          body: 'A fictional update for the demo user.',
          occurredAt: '2026-01-01T12:00:00Z',
          severity: 'info',
          readAt: null,
        },
      ],
    },
  };
  // Recipient-scoped reads use the bell provider, never generated model routes.
  static nav = [];
  static help = './help/notifications.md';
}

/** Slack messages from connected workspaces, read by channel and thread. */
export class SlackRecipe extends SmrtRecipe {
  static id = 'messages.slack';
  static label = 'Slack';
  static summary = 'Read Slack messages from your connected workspaces.';
  static synonyms = [
    'slack',
    'slack messages',
    'slack channels',
    'workspace chat',
    'team chat',
  ];
  static group = {
    id: 'messages',
    label: 'Messaging',
    summary: 'Choose email and personal updates independently.',
  };
  static section = {
    id: 'messages',
    label: 'Messaging',
    icon: 'folder',
    description: 'Read email and keep up with updates addressed to you.',
  };
  static models = [SlackMessage, SlackAccount];
  static nav = [
    {
      label: 'Slack messages',
      model: SlackMessage,
      key: 'slack-messages',
      icon: 'chat',
      noun: 'message',
      description: 'Read messages from your connected workspaces by channel.',
    },
    {
      label: 'Slack workspaces',
      model: SlackAccount,
      icon: 'users',
      noun: 'workspace',
      description: 'The workspaces your application is connected to.',
    },
  ];
  static help = './help/slack.md';
  static options = {
    SlackMessage: {
      fields: {
        channelName: { label: 'Channel', order: 1 },
        body: { label: 'Message', order: 2 },
        threadId: { label: 'Thread', order: 3 },
        sendStatus: { label: 'Sent status', order: 4 },
        accountId: { label: 'Workspace', order: 5 },
        fromName: { label: 'From', visibility: 'advanced' },
        fromAddress: { visibility: 'advanced' },
        toAddresses: { visibility: 'advanced' },
        subject: { visibility: 'advanced' },
        date: { visibility: 'advanced' },
        isRead: { visibility: 'advanced' },
        isFlagged: { visibility: 'advanced' },
        isEdited: { label: 'Edited', visibility: 'advanced' },
        messageType: { label: 'Message kind', visibility: 'advanced' },
        reactions: { visibility: 'advanced' },
        hasAttachments: { visibility: 'advanced' },
        channelId: { visibility: 'advanced' },
        sentAt: { visibility: 'advanced' },
        sendError: { visibility: 'advanced' },
        scheduledSendAt: { visibility: 'advanced' },
        inReplyToMessageId: { label: 'Replying to', visibility: 'advanced' },
        personaId: { visibility: 'advanced' },
        endpointId: { visibility: 'advanced' },
        retryCount: { visibility: 'hidden' },
        maxRetries: { visibility: 'hidden' },
        size: { visibility: 'hidden' },
        correlationId: { visibility: 'hidden' },
        slackTs: { visibility: 'hidden' },
        slackThreadTs: { visibility: 'hidden' },
        blocks: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
        tenantId: { visibility: 'hidden' },
        created_at: { help: 'When this message was first recorded.' },
        updated_at: { help: 'When this message record was last changed.' },
      },
    },
    SlackAccount: {
      fields: {
        name: { order: 1 },
        workspaceName: { label: 'Workspace', order: 2 },
        isActive: { label: 'Enabled', order: 3 },
        lastSyncAt: { label: 'Last checked', order: 4 },
        workspaceId: { visibility: 'advanced' },
        botUserId: { label: 'Bot user', visibility: 'advanced' },
        providerType: { visibility: 'advanced' },
        channelType: { visibility: 'advanced' },
        configuration: { visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        created_at: {
          help: 'When this workspace connection was first recorded.',
        },
        updated_at: {
          help: 'When this workspace connection was last changed.',
        },
      },
    },
  } as const;
}
