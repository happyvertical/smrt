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
  // Recipient-scoped reads use the bell provider, never generated model routes.
  static nav = [];
  static help = './help/notifications.md';
}
