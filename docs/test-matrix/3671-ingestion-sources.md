# #3671 source intake behavior matrix

Source transport preserves originals through the public `IngestionService.receive` boundary. No source runs domain handlers. This is feature work; base regression comparison is N/A because the adapters and byte snapshot API do not exist on base.

All database cases run with real SQLite and PostgreSQL via `pnpm --filter @happyvertical/smrt-ingestion test` and `pnpm --filter @happyvertical/smrt-ingestion test:postgres`. Source transport doubles exercise contract behavior, not provider quality. Filesystem cases use actual temporary files. Messages API tests run via `pnpm --filter @happyvertical/smrt-messages test`.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level / command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Authenticated delivery binding | JSON / multipart request | Trusted session selects source/service | Missing auth; forged authority; revoked grant; other tenant/actor/scope | Host session × source ownership × active grant | Service rechecks reservation transaction; adapters never issue SQL | Node / SQLite + PostgreSQL | Invalid JSON, unknown fields, missing optional fields | Source integration / ingestion test + test:postgres |
| Original bounded upload | Multipart camera/audio/document | Original bytes, signature, capture ID/hash/time retained; reordered multipart fields replay same receipt | Declared/actual size overflow, bad type/signature/hash | Trusted enabled upload source | All parts validated before receipt; service atomic reservation | Node / both | Mobile Idempotency-Key, MIME, stream failure | Source integration / both |
| Owner references | JSON asset/message reference | Host-authorized immutable byte snapshot copied | Missing bytes / denied ownership; no receipt | Host resolver receives authenticated binding, never supplied tenant | Owner I/O outside ingestion transaction | Node / both | Owner deletion/unavailable | Source integration / both |
| Email identity and attachments | Configured account delivery | Body, thread, multiple attachment parents; repeat success; explicit revision | Missing bytes, account mismatch, upstream failure; checkpoint unchanged | Configured account and service only | All bytes obtained before receive; checkpoint after ready | Node / both | SDK getMessage, absent fields, no provider secrets in snapshot | Source integration + messages unit / both + messages test |
| Email full-message quota | Exact final message JSON plus attachment bytes | Boundary accepts, one byte below rejects; empty attachments array included | Oversized UTF-8/escaped filename or many empty attachment descriptors reject before payload copies | Configured account; unchanged authority | Read-only accounting before snapshot/receipt; no transaction | Node; existing source SQLite/PG contract unchanged | Actual preserved descriptor keys/order and byte lengths | Messages email-intake regression + source integration |
| Watch stability and claim | Poll configured directory | Stable PDF/TIFF atomic move to claim; acknowledgement only after ready | Partial writes, symlinks, malformed types, receive retry; retained claim visible | Host-owned private directory; unconfigured input untouched | Atomic filesystem rename; DB receipt transaction; recoverable cross-resource boundary | Node / both | Producer filesystem, concurrent poll/restart | Real files + DB integration / both |
| Restart / ack crash | Death after import before processed move | Same persisted claim UUID replays same receipt | Failure never removes original; recovery waits stability again | Same source configuration | Receipt identity bridges filesystem/DB | Node / both | Child-process death | Process integration / both |
| Vendor authentication | Verified raw webhook | Verifier returns trusted delivery identity/source; duplicate replay | Authentication failure, oversize/malformed input; safe errors | Host vendor verifier; raw content cannot select authority | Same receive transaction | Node / both | Signature verification callback; no vendor SDK selected | Source integration / both |

UI, extraction/provider accuracy, domain execution, migration/schema changes: N/A; this change has no UI, extraction, domain mutation or new schema. Existing receipt rollback/fencing lanes remain part of the full ingestion suites.

## Provider byte-path provenance

Initial pre-review inspection used `@happyvertical/email@0.102.3`, `dist/index.js` SHA-256
`568235976fa38d4ea5f6de22186cc3ef1e1fc69dc427b5ef9d319c44464303ee`:
Gmail `getMessage` (line 124) requests `users.messages.get({format:'raw'})`,
decodes and parses MIME, and maps actual `attachment.content` (line 170).
IMAP `getMessage` (line 595) searches RFC Message-ID and fetches `source:true`;
`parseMessage` (lines 859–891) returns the transport UID and attachment bytes.
POP3 `getMessage` (line 1005) resolves UIDL and calls full-message retrieval,
whose MIME mapping retains bytes (line 1141). The messages seam verifies IMAP
folder UIDVALIDITY and returned UID against the host's transport identity;
RFC Message-ID alone is insufficient. Tests inject the public client transport,
not attachment metadata pretending to be bytes. No live mailbox/provider quality
or extraction accuracy claim is made.

Mobile convention provenance: `smrt-mobile/.../network/MobileApiClient.kt`
`uploadMultipart`/`execute` retain MIME-bearing file parts and `Idempotency-Key`;
`evidence/EvidenceCapture.kt` defines `camera`/`native_picker` and explicit
SHA-256 metadata. The ingestion reference route maps the durable upload UUID to
`captureId`; host-side payload assembly remains application-owned. Stub captures
and client local paths are not accepted as preserved bytes.

## Released email provider correction

Email intake requires `@happyvertical/email >=0.102.4` within the catalog range. The installed 0.102.4 `dist/index.js` SHA-256 is `ae8f9013cf05a99bf8730f3523c152c2a97e66260619faa59b423b514d2773cd`. SDK repair happyvertical/sdk#1379 (PR#1380) makes all IMAP UID-result fetches use UID-mode ranges and retains POP3 parsed reply provenance. IMAP already retained reply headers; only its UID retrieval needed correction. The consumer preserves its existing folder/UIDVALIDITY/UID checks. Protocol-boundary evidence uses the released package with UID42 at sequence1, actual MIME parsing/attachment bytes and POP3 parent headers; it does not claim live mailbox quality or credential-store integration.

At reviewed round 2, the targeted pnpm update extended only the existing exact-version email release-age allowance to verified 0.102.4; other SDK versions stayed unchanged in that revision. The repository alignment gate requires the SDK catalog and overrides to advance together, so the source branch now inherits the normally merged PR #3695 SDK 0.102.4 synchronization. Quarantine settings remain intact. SDK release-source comparison shows only the already-reviewed IMAP/POP3 repair changes runtime source; other SDK changes are release metadata. Source adapter implementation/test files remain byte-identical to reviewed round 2. The subsequent messages snapshot quota correction counts the exact serialized attachment descriptors plus payload bytes before copying attachments; its boundary and oversized-metadata regressions fail against the previous calculation.

If an earlier deployment preserved POP3 snapshots without parent metadata, recover from retained upstream originals with an explicit new source revision; existing immutable receipts are not silently rewritten.
