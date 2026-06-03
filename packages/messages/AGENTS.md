# @happyvertical/smrt-messages

Multi-channel messaging with STI hierarchies for both messages and accounts. Credential encryption via smrt-secrets.

## STI Hierarchies

**Messages** (share `messages` table):
- `Message` (base): accountId, threadId, subject, body, fromAddress, toAddresses (JSON), sendStatus (draft/sending/sent/failed), retryCount
- `Email`: messageId (RFC 822), inReplyTo, ccAddresses, bccAddresses, htmlBody, textBody, folderId, labels, headers
- `Tweet`: tweetId, retweetCount, likeCount, mediaUrls, hashtags, mentions
- `SlackMessage`: channelId, slackTs, slackThreadTs, reactions, blocks

**Accounts** (share `accounts` table):
- `Account` (base): providerType, credentialSecretId, isActive, lastSyncAt, settings
- `EmailAccount`, `TwitterAccount`, `SlackAccount`: provider-specific fields + sync methods

## Credential Security

Account credentials stored via `credentialSecretId` → smrt-secrets. Use `setCredentials()`/`getCredentials()` — never store passwords directly.

## Send Lifecycle

`message.send()`: resolves account → creates provider sender → updates sendStatus. Retry support with `maxRetries` budget.

## Gotchas

- **STI `_meta_type`**: qualified format `@happyvertical/smrt-messages:Email`
- **JSON fields**: all address/metadata fields are JSON strings with `getX()`/`setX()` helpers
- **RFC 822 threading**: Email uses `inReplyTo`/`messageId`/`references` — manual management required
- **Attachment.messageId**: use this field (not `emailId`); old getter/setter mapped via deprecation wrapper
- **Optional tenancy**: `@TenantScoped({ mode: 'optional' })` on Message, Account, Attachment
