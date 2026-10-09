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
  static models = [Email, EmailAccount];
  static nav = [{ label: 'Mailbox', model: Email }];
  static help = './help/mailbox.md';
}

/** Recipient-scoped in-app notification bell. */
export class NotificationsRecipe extends SmrtRecipe {
  static id = 'messages.notifications';
  static label = 'Notifications';
  static summary = 'See updates addressed to you and mark them read.';
  static synonyms = ['alerts', 'notification bell'];
  static models = [UserNotification];
  static help = './help/notifications.md';
}
