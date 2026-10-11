import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Email } from './models/Email.js';
import { EmailAccount } from './models/EmailAccount.js';
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
