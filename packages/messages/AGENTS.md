# @happyvertical/smrt-messages

Multi-channel messaging with STI hierarchies for both messages and accounts. Credential encryption via smrt-secrets.

## STI Hierarchies

**Messages** (share `messages` table):
- `Message` (base): accountId, personaId, endpointId, correlationId, threadId, subject, body, fromAddress, toAddresses (JSON), sendStatus (draft/sending/sent/failed), retryCount
- `Email`: messageId (RFC 822), inReplyTo, ccAddresses, bccAddresses, htmlBody, textBody, folderId, labels, headers
- `Tweet`: tweetId, retweetCount, likeCount, mediaUrls, hashtags, mentions
- `SlackMessage`: channelId, slackTs, slackThreadTs, reactions, blocks

**Accounts** (share `accounts` table):
- `Account` (base): channelType, providerType, public configuration,
  credentialSecretId, isActive, lastSyncAt, deprecated sensitive settings
- `EmailAccount`, `TwitterAccount`, `SlackAccount`, `ZulipAccount`,
  `TelegramAccount`: provider-specific identity/sender behavior

## Persona messaging

- `MessagingEndpoint`: tenant-owned, write-only destination JSON with masked
  display helper.
- `PersonaMessageRoute`: persona → account + endpoint, selected by purpose and
  descending priority.
- `PersonaMessagingService`: persists and sends through an enabled route.
- Provider registry: public setup descriptors + optional sender factory. Keep
  channel (`sms`) separate from provider (`twilio`).
- Permissions: `messages.send`, `messages.manage-routes`,
  `messages.manage-credentials`.
- `MessagingSettingsService` is the permissioned server boundary;
  its host-supplied `resolvePersonaTenantId` proves cross-package ownership.
  `MessagingSettingsPanel` is the callback-driven Svelte surface.
- Account, endpoint, and route generated surfaces are read-only. Do not add
  generated mutations around the settings service or make secret fields writable.

## Credential Security

Account credentials stored via tenant-bound `credentialSecretId` →
smrt-secrets. Use `setCredentials()`/`getCredentials()` — never store passwords
directly. Credential descriptor schemas contain field definitions, never values.

## Send Lifecycle

`message.send()`: resolves account → creates provider sender → updates sendStatus. Retry support with `maxRetries` budget.

## Gotchas

- **STI `_meta_type`**: qualified format `@happyvertical/smrt-messages:Email`
- **JSON fields**: all address/metadata fields are JSON strings with `getX()`/`setX()` helpers
- **RFC 822 threading**: Email uses `inReplyTo`/`messageId`/`references` — manual management required
- **Attachment.messageId**: use this field (not `emailId`); old getter/setter mapped via deprecation wrapper
- **Optional tenancy**: `@TenantScoped({ mode: 'optional' })` on Message, Account, Attachment
- **Required tenancy**: endpoints and persona routes are always tenant scoped
- **Secrets are write-only**: never serialize credentials or endpoint.address to an app
