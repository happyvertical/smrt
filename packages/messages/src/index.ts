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

import { ensureMailAccessEnforcementRegistered } from './access-enforcement.js';
import { ensureMessagingPermissionsRegistered } from './permissions.js';

// ─────────────────────────────────────────────────────────────────────────
// Per-account mail access (owner + grants; see access.ts)
// ─────────────────────────────────────────────────────────────────────────
export {
  assertMailAccess,
  canAccessMailAccount,
  configureMailAccess,
  decideMailAccess,
  deniedMailAccountIds,
  type GrantMailAccessInput,
  isMailScope,
  MAIL_ACCOUNT_RESOURCE_TYPE,
  MAIL_SCOPES,
  type MailAccessAdmin,
  type MailAccessConfig,
  type MailAccessDecision,
  MailAccessError,
  type MailAccessReason,
  type MailAccessResolver,
  type MailAccessResolverContext,
  MailAccessService,
  type MailAccessSubject,
  type MailPrincipal,
  type MailScope,
  mailScopePermission,
  resetMailAccess,
  runWithMailSystemAccess,
} from './access.js';
export type {
  MailSyncOptions,
  MailSyncResult,
  MailSyncSkipReason,
} from './mail-sync.js';
export {
  CHANGE_FEED_PROVIDERS,
  type EnqueueMailSyncOptions,
  enqueueDueMailSyncs,
  enqueueMailSync,
  MAIL_SYNC_QUEUE,
  mailSyncDedupeKey,
} from './mail-sync-jobs.js';
export {
  type MailTriageAction,
  type MailTriageActionKind,
  type MailTriageFailure,
  type MailTriageResult,
  type MailWriteBackCapability,
  MailWriteBackUnsupportedError,
} from './mail-triage.js';

import { ensureBuiltinMessagingProvidersRegistered } from './providers.js';

// ─────────────────────────────────────────────────────────────────────────
// Base classes (new)
// ─────────────────────────────────────────────────────────────────────────

export { AccountCollection } from './collections/AccountCollection';
export { AttachmentCollection } from './collections/AttachmentCollection';
export { CorrespondentCollection } from './collections/CorrespondentCollection.js';
// Base collections
export { MessageCollection } from './collections/MessageCollection';
export { MessagingEndpointCollection } from './collections/MessagingEndpointCollection.js';
export { NotificationDeliveryCollection } from './collections/NotificationDeliveryCollection.js';
export { NotificationOptOutCollection } from './collections/NotificationOptOutCollection.js';
export { PersonaMessageRouteCollection } from './collections/PersonaMessageRouteCollection.js';
export { UserNotificationCollection } from './collections/UserNotificationCollection.js';
export { Account } from './models/Account';
export { Attachment } from './models/Attachment';
export {
  Correspondent,
  type CorrespondentOptions,
} from './models/Correspondent.js';
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
  MESSAGES_ROLE_PERMISSION_MATRIX,
  MESSAGING_PERMISSION_DEFINITIONS,
  type MessagingPrincipal,
  messagingPrincipalFromPermissions,
  SEND_MESSAGES_PERMISSION,
  type SeedMessagesRolePermissionsResult,
  seedMessagesRolePermissions,
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
  type CorrespondentRefreshResult,
  CorrespondentService,
  type CorrespondentServiceOptions,
  type CorrespondentView,
  type ListCorrespondentsOptions,
  normalizeCorrespondentAddress,
} from './services/CorrespondentService.js';
export {
  type MailProviderSearchResult,
  type MailSearchHit,
  type MailSearchPage,
  type MailSearchQuery,
  MailSearchService,
  type MailSearchServiceOptions,
  readableMailAccounts,
} from './services/MailSearchService.js';
export {
  type ListAccountsOptions,
  type ListAccountsResult,
  type MessagingAccountInput,
  type MessagingAccountListing,
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
ensureMailAccessEnforcementRegistered();

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
