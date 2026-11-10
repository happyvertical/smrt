/**
 * @happyvertical/smrt-messages
 *
 * Unified multi-channel messaging with STI-based hierarchies
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

import { ensureMessagingPermissionsRegistered } from './permissions.js';
import { ensureBuiltinMessagingProvidersRegistered } from './providers.js';

// ─────────────────────────────────────────────────────────────────────────
// Base classes (new)
// ─────────────────────────────────────────────────────────────────────────

export { AccountCollection } from './collections/AccountCollection';
export { AttachmentCollection } from './collections/AttachmentCollection';
// Base collections
export { MessageCollection } from './collections/MessageCollection';
export { MessagingEndpointCollection } from './collections/MessagingEndpointCollection.js';
export { NotificationDeliveryCollection } from './collections/NotificationDeliveryCollection.js';
export { NotificationOptOutCollection } from './collections/NotificationOptOutCollection.js';
export { PersonaMessageRouteCollection } from './collections/PersonaMessageRouteCollection.js';
export { UserNotificationCollection } from './collections/UserNotificationCollection.js';
export { Account } from './models/Account';
export { Attachment } from './models/Attachment';
// Base models
export { Message } from './models/Message';
export { MessagingEndpoint } from './models/MessagingEndpoint.js';
export {
  NOTIFICATION_DELIVERY_CHANNELS,
  NotificationDelivery,
  type NotificationDeliveryChannel,
  type NotificationDeliveryOptions,
  type NotificationDeliveryStatus,
  type NotificationDeliveryTransition,
} from './models/NotificationDelivery.js';
export {
  isValidNotificationOptOutScope,
  NOTIFICATION_OPT_OUT_ALL_SCOPE,
  NOTIFICATION_OPT_OUT_SCOPE_PATTERN,
  NotificationOptOut,
  type NotificationOptOutOptions,
} from './models/NotificationOptOut.js';
export { PersonaMessageRoute } from './models/PersonaMessageRoute.js';
export {
  USER_NOTIFICATION_SEVERITIES,
  UserNotification,
  type UserNotificationOptions,
  type UserNotificationSeverity,
} from './models/UserNotification.js';

// ─────────────────────────────────────────────────────────────────────────
// Email (backward-compatible)
// ─────────────────────────────────────────────────────────────────────────

export { EmailAccountCollection } from './collections/EmailAccountCollection';
export { EmailAttachmentCollection } from './collections/EmailAttachmentCollection';
// Email collections
export { EmailCollection } from './collections/EmailCollection';
export { EmailFolderCollection } from './collections/EmailFolderCollection';
// Email models
export { Email } from './models/Email';
export { EmailAccount } from './models/EmailAccount';
export { EmailAttachment } from './models/EmailAttachment';
export { EmailFolder } from './models/EmailFolder';

// ─────────────────────────────────────────────────────────────────────────
// Email filtering (whitelist/blacklist)
// ─────────────────────────────────────────────────────────────────────────

export { BlacklistCollection } from './collections/BlacklistCollection';
export { WhitelistCollection } from './collections/WhitelistCollection';
export { Blacklist } from './models/Blacklist';
export { Whitelist } from './models/Whitelist';

// ─────────────────────────────────────────────────────────────────────────
// Provider stubs
// ─────────────────────────────────────────────────────────────────────────

// Account types
export { SlackAccount } from './models/SlackAccount';
export { SlackMessage } from './models/SlackMessage';
export { TelegramAccount } from './models/TelegramAccount.js';
// Message types
export { Tweet } from './models/Tweet';
export { TwitterAccount } from './models/TwitterAccount';
export { ZulipAccount } from './models/ZulipAccount.js';

// ─────────────────────────────────────────────────────────────────────────
// Senders
// ─────────────────────────────────────────────────────────────────────────

export {
  assertMessagingPermission,
  ensureMessagingPermissionsRegistered,
  MANAGE_MESSAGE_CREDENTIALS_PERMISSION,
  MANAGE_MESSAGE_ROUTES_PERMISSION,
  MESSAGING_PERMISSION_DEFINITIONS,
  type MessagingPrincipal,
  messagingPrincipalFromPermissions,
  SEND_MESSAGES_PERMISSION,
} from './permissions.js';
export {
  ensureBuiltinMessagingProvidersRegistered,
  getMessagingProvider,
  listMessagingProviders,
  type MessagingProviderDefinition,
  type MessagingProviderField,
  type MessagingProviderFieldType,
  registerMessagingProvider,
} from './providers.js';
export { EmailSender } from './senders/EmailSender';
export { SlackSender } from './senders/SlackSender';
export { TelegramSender } from './senders/TelegramSender.js';
export { TweetSender } from './senders/TweetSender';
export { ZulipSender } from './senders/ZulipSender.js';
export {
  type MessagingAccountInput,
  type MessagingAccountView,
  type MessagingEndpointInput,
  type MessagingEndpointView,
  MessagingSettingsService,
  type PersonaMessageRouteInput,
} from './services/MessagingSettingsService.js';
export {
  type NotificationOptOutChange,
  type NotificationOptOutDenialReason,
  NotificationOptOutDeniedError,
  type NotificationOptOutKey,
  type NotificationOptOutListRequest,
  type NotificationOptOutPrincipal,
  NotificationOptOutService,
  optOutSuppression,
} from './services/NotificationOptOutService.js';
export {
  buildNotificationLink,
  messageSendTransport,
  type NotificationDispatchOptions,
  type NotificationDispatchOutcome,
  type NotificationDispatchReport,
  type NotificationEmailInput,
  type NotificationEnqueueResult,
  type NotificationOutboxDenialReason,
  NotificationOutboxDeniedError,
  type NotificationOutboxOptions,
  NotificationOutboxService,
  type NotificationProfileRecipientRequest,
  type NotificationProfileSuppressionRequest,
  type NotificationRecipient,
  type NotificationRecipientRequest,
  type NotificationReconcileOutcome,
  type NotificationSuppressionRequest,
  type NotificationTransport,
  type NotificationTransportOutcome,
  type NotificationTransportReconciliation,
  type NotificationTransportRequest,
  notificationDeliveryCorrelationId,
  notificationDeliveryMessageId,
} from './services/NotificationOutboxService.js';
export {
  type PersonaMessageSendResult,
  PersonaMessagingService,
} from './services/PersonaMessagingService.js';
export {
  type UserNotificationInput,
  type UserNotificationListOptions,
  type UserNotificationNotifyResult,
  type UserNotificationScope,
  UserNotificationService,
} from './services/UserNotificationService.js';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type {
  AccountOptions,
  AccountSearchFilters,
  AccountType,
  AttachmentOptions,
  // Email options (backward compat)
  EmailAccountOptions,
  EmailAccountSearchFilters,
  EmailAttachmentOptions,
  EmailFolderOptions,
  EmailFolderSearchFilters,
  EmailOptions,
  EmailSearchFilters,
  KnownMessagingChannel,
  // Base options
  MessageOptions,
  // Search filters
  MessageSearchFilters,
  MessageSenderInterface,
  // Send types
  MessageSendResult,
  // Discriminator types
  MessageType,
  MessagingChannel,
  MessagingEndpointOptions,
  PersonaMessageRouteOptions,
  ProviderType,
  SendEmailAttachment,
  SendEmailOptions,
  SendMessageOptions,
  SendPersonaMessageOptions,
  SendSlackOptions,
  SendStatus,
  SendTweetOptions,
  SlackAccountOptions,
  SlackMessageOptions,
  // Sync types
  SyncOptions,
  SyncProgress,
  SyncResult,
  // Provider options
  TweetOptions,
  TwitterAccountOptions,
} from './types';

ensureBuiltinMessagingProvidersRegistered();
ensureMessagingPermissionsRegistered();

export {
  assertNotificationProfileRecipientSchema,
  migrateNotificationProfileRecipients,
  type NotificationProfileRecipientEngine,
  type NotificationProfileRecipientPlan,
  planNotificationProfileRecipients,
} from './migrations/profileRecipients.js';
export {
  type NotificationRecipientIdentity,
  PROFILE_NOTIFICATION_POLICY_PREFIX,
  profileNotificationPolicy,
} from './notification-recipient-identity.js';
export { MailboxRecipe, NotificationsRecipe, SlackRecipe } from './recipes.js';
