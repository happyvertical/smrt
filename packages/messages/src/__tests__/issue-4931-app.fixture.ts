import { smrt } from '@happyvertical/smrt-core';
import { Account as SmrtAccount } from '../models/Account.js';
import { Email as SmrtEmail } from '../models/Email.js';
import { EmailAccount as SmrtEmailAccount } from '../models/EmailAccount.js';
import { EmailFolder as SmrtEmailFolder } from '../models/EmailFolder.js';
import { Message as SmrtMessage } from '../models/Message.js';
import { MessagingEndpoint as SmrtMessagingEndpoint } from '../models/MessagingEndpoint.js';
import { NotificationOptOut as SmrtNotificationOptOut } from '../models/NotificationOptOut.js';
import { PersonaMessageRoute as SmrtPersonaMessageRoute } from '../models/PersonaMessageRoute.js';
import { TelegramAccount as SmrtTelegramAccount } from '../models/TelegramAccount.js';
import { ZulipAccount as SmrtZulipAccount } from '../models/ZulipAccount.js';

// Register only after the framework models and a registry snapshot are loaded.
export function registerAppModels(): {
  EmailFolder: typeof SmrtEmailFolder;
  Account: typeof SmrtAccount;
  EmailAccount: typeof SmrtEmailAccount;
  Email: typeof SmrtEmail;
  Message: typeof SmrtMessage;
  MessagingEndpoint: typeof SmrtMessagingEndpoint;
  PersonaMessageRoute: typeof SmrtPersonaMessageRoute;
  TelegramAccount: typeof SmrtTelegramAccount;
  ZulipAccount: typeof SmrtZulipAccount;
  NotificationOptOut: typeof SmrtNotificationOptOut;
} {
  class Account extends SmrtAccount {}
  smrt({ packageName: '@local/issue-4931-messages' })(Account);
  class EmailAccount extends SmrtEmailAccount {}
  smrt({ packageName: '@local/issue-4931-messages' })(EmailAccount);
  class Email extends SmrtEmail {}
  smrt({ packageName: '@local/issue-4931-messages' })(Email);
  class Message extends SmrtMessage {}
  smrt({ packageName: '@local/issue-4931-messages' })(Message);
  class MessagingEndpoint extends SmrtMessagingEndpoint {}
  smrt({ packageName: '@local/issue-4931-messages' })(MessagingEndpoint);
  class PersonaMessageRoute extends SmrtPersonaMessageRoute {}
  smrt({ packageName: '@local/issue-4931-messages' })(PersonaMessageRoute);
  class TelegramAccount extends SmrtTelegramAccount {}
  smrt({ packageName: '@local/issue-4931-messages' })(TelegramAccount);
  class ZulipAccount extends SmrtZulipAccount {}
  smrt({ packageName: '@local/issue-4931-messages' })(ZulipAccount);
  class NotificationOptOut extends SmrtNotificationOptOut {}
  smrt({ packageName: '@local/issue-4931-messages' })(NotificationOptOut);
  class EmailFolder extends SmrtEmailFolder {}
  smrt({ packageName: '@local/issue-4931-messages' })(EmailFolder);
  return {
    EmailFolder,
    Account,
    EmailAccount,
    Email,
    Message,
    MessagingEndpoint,
    PersonaMessageRoute,
    TelegramAccount,
    ZulipAccount,
    NotificationOptOut,
  };
}
