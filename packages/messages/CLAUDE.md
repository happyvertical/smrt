# @happyvertical/smrt-messages

Email message persistence and synchronization. Stores email metadata, attachments, and folder structures with credential management via smrt-secrets.

## Architecture

```
src/
  index.ts              # Export barrel
  types.ts              # ProviderType, SyncOptions, EmailSearchFilters
  models/
    Email.ts            # RFC 822 message record
    EmailAccount.ts     # Account config with provider type
    EmailFolder.ts      # IMAP folder hierarchy
    EmailAttachment.ts  # Attachment metadata
  collections/
    EmailCollection.ts          # Query by messageId, account, folder, thread
    EmailAccountCollection.ts   # Account management
    EmailFolderCollection.ts    # Folder hierarchy
    EmailAttachmentCollection.ts
```

## Key Models

- `Email` — RFC 822 compliant message: addresses as JSON, headers as JSON, thread tracking
- `EmailAccount` — Account credentials with provider type (imap/smtp/pop3/gmail), sync tracking
- `EmailFolder` — IMAP folder hierarchy with special use flags
- `EmailAttachment` — Attachment metadata with content disposition and file path

## Key Patterns

- **Credential security**: Uses `credentialSecretId` reference to `@happyvertical/smrt-secrets` (never stores passwords directly)
- **Thread tracking**: Emails linked via threadId for conversation view
- **Sync tracking**: Last sync timestamps on EmailAccount for incremental sync
- **Multi-tenancy**: Optional tenant scoping via `@TenantScoped`

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`, `@happyvertical/smrt-secrets`
- `@happyvertical/ai`, `@happyvertical/email`, `@happyvertical/files`, `@happyvertical/sql`
- Optional peer: `@happyvertical/encryption` (for credential encryption)
