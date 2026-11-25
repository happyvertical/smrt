# Attachment storage root (#5645)

`Attachment.filePath` is a path relative to one root the host sets once at
startup with `configureAttachmentStorage({ root })` (`attachment-storage.ts`,
beside `configureMailAccess`; `resetAttachmentStorage()` for tests). The root
must be an absolute, existing directory; its real path is resolved once.

- **Write** (`Attachment.save()`, so also `AttachmentCollection.create` and the
  generated `create` route): refuses an absolute path, a `..` segment, a
  backslash, a control character (NUL included), `%2e`/`%2f`/`%5c` (any case,
  any `%25` nesting) and an empty result with `AttachmentStorageError`
  (`status` 400); stores the normalised relative path. Needs no root.
- **Read** (`readContent()`, the only reader): no root configured throws
  `AttachmentStorageError` naming `configureAttachmentStorage` (fail closed);
  the stored path is re-checked (rows written earlier with an absolute or
  escaping path are refused), the target's real path is resolved, and one
  outside the root's real path throws. Missing or unreadable file stays `null`.
- **Send / held send**: `EmailSender` turns a refusal into the failed send
  `Attachment "x" was not sent: ...` (recorded on `sendError`, nothing reaches
  the transport); `mailSendBindingHash` binds a refused row as `unreadable`.
- **Upgrade**: a host that stored absolute paths must set the root and move the
  files and rows under it as relative paths; until then those sends fail.
  `backfillAccountIds()` writes the column directly so such rows still fill.

## Trust boundary

Reads check the real path just before opening it, so the root must not be
writable by untrusted parties (hard links or a symlink swap inside the root between the check and the
read is not defended). Any file under the root can be named by any writer of an
`Attachment` row; keep per-tenant files in per-tenant roots or apply your own
prefix rule in the host.
