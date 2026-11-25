# Attachment storage root (#5645)

`Attachment.filePath` is a path relative to one root the host sets once at
startup with `configureAttachmentStorage({ root })` (`attachment-storage.ts`,
beside `configureMailAccess`; `resetAttachmentStorage()` for tests). The root
must be an absolute, existing directory; its real path is resolved once.

- **Layout**: a file lives at `<root>/<accountId>/<path>`, and `filePath` is
  stored as `<accountId>/<path>`, where `accountId` is the account of the
  message the attachment is on. Account ids are unique across tenants, so this
  one prefix scopes both tenant and account (an attachment's own `tenantId` is
  optional, but its message always has an account).
- **Write** (`Attachment.save()`, so also `AttachmentCollection.create` and the
  generated `create` route): refuses an absolute path, a `..` segment, a
  backslash, a control character (NUL included), `%2e`/`%2f`/`%5c` (any case,
  any `%25` nesting) and an empty result, or a path not under `<accountId>/` of the message's current
  account (read from the stored message, never the row's own `accountId`), with
  `AttachmentStorageError`
  (`status` 400); stores the normalised relative path. Needs no root.
- **Read** (`readContent()`, the only reader): no root configured throws
  `AttachmentStorageError` naming `configureAttachmentStorage` (fail closed);
  the stored path is re-checked against the message's current account, so an
  attachment moved to another account's message loses its file (rows written earlier with an absolute or
  escaping path are refused), the target's real path is resolved, and one
  outside the account's own directory (or the root) throws. Missing or unreadable file stays `null`.
- **Send / held send**: `EmailSender` turns a refusal into the failed send
  `Attachment "x" was not sent: ...` (recorded on `sendError`, nothing reaches
  the transport); `mailSendBindingHash` binds a refused row as `unreadable`.
- **Upgrade**: a host that stored absolute paths must set the root, move each
  file to `<root>/<accountId>/...` and rewrite its row as the relative path
  `<accountId>/...`, using the account of the row's message; until then those sends fail.
  `backfillAccountIds()` writes the column directly so such rows still fill.

## Trust boundary

Reads check the real path just before opening it, so the root must not be
writable by untrusted parties (hard links or a symlink swap inside the root between the check and the
read is not defended). The per-account prefix stops one account naming another
account's file; it does not separate writers within one account.
