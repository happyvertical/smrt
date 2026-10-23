# @happyvertical/smrt-ingestion

Durable receipt, evidence, analysis attempts and action-journal foundations for
[ADR 0004](../../docs/adr/0004-application-aware-ingestion.md).

The root, `/models` and `/dto` entry points are browser-safe. Import
`IngestionService` from `/server` in trusted host code. Generated REST, CLI and
MCP access to the persistence models is disabled; hosts expose authorized DTO
methods through their authenticated application transport.

Before starting a service, deploy the package manifest through the public s-m-r-t
migration APIs or `smrt db:migrate`. `assertReady()` only checks existing tables.
SQLite and PostgreSQL are supported; other engines fail construction. Index
additions ship the same way: `intake_items_received_idx` (newest-first inbox
paging on `tenant_id, confidential_scope_id, created_at, id`) is declared on the model and reaches existing deployments through the
next manifest migration; there are no hand-written migration files in this
package, and `smrt doctor --db` / `db:status --parity` report the index until
it is applied.

`listItemsPage({ limit?, cursor?, state?, itemIds?, scanLimit? })` returns
`{ items: [{ item, state, cursor }], scanned, nextCursor? }`: one authorized
inbox page newest receipt first with each row's durable inbox state and
continuation cursor, and the number of rows the call examined. `listItems()`
remains as a deprecated array-returning method that walks the private page
scan to the end. Without the optional `cursorKey` service option every cursor
names the last row the actor can read, and a page that finds no readable row
within its scan limit fails with `IntakeScanLimitError`; with a server secret
of at least 32 bytes, cursors are sealed and such a page resumes past what it
skipped. `scanned` is for host
accounting only. See [REVIEW.md](REVIEW.md) for the paging and authorization
contract.

A host supplies a database, AssetRuntime, authenticated tenant/actor/confidential
scope, a live authorization callback, a registered jobs target, and an idempotent
`purgeDerived` callback for host-owned previews, retrieval indexes and caches.
The authorization callback receives the captured ceiling and the current
transaction executor; it must intersect current grants with that ceiling. Never
construct the scope, retention policy or budgets from incoming document labels.

`receive` accepts bounded original byte buffers, with stable source part IDs,
parent relationships, optional upstream identity/version and an optional
original `filename` (kept for labels on `IntakeEvidenceDTO.filename`, never
part of receipt identity). The multipart upload source, email attachments and
the watched folder all supply it, as may a host `snapshotReference` part or a
vendor webhook's verified parts. Every source delivers through one place that
removes control, format (bidi, zero-width, tag), line-separator and
default-ignorable characters (Unicode properties, see
`src/presented-filename.ts`) and drops a name that is then empty or over 512
characters, so an odd name falls back to the default label instead of failing
the receipt (`receive` itself rejects such a name from a direct caller as
`invalid`, and names are cleaned again when read back). Removing every format
and default-ignorable character has display-only effects, since nothing uses
the name as identity: emoji ZWJ sequences and presentation selectors flatten,
ZWNJ/ZWJ are removed from Persian and Indic text (letters may join
differently), and ideographic variation selectors are removed (a CJK variant
shows its base glyph). Unicode normalization
(NFC/NFKC) and confusable look-alike characters are out of scope: the name is
still untrusted text, so render it as text, never as markup or a path. The
upstream `sourceReference` is stored but not exposed on the DTO: its ids are
upstream locators, not display text, and they are never cleaned. For email
they are the provider's message locator (plus the attachment part id); for the
watched folder the id is the raw folder entry name, whose cleaned form is what
`filename` exposes. Source adapters own
streaming and upstream snapshot retrieval. Receipt identity is tenant + source +
delivery key; changing bytes or authenticated scope conflicts. Content equality
in a different conversation does not deduplicate an arrival. The returned item
ID and version are safe acknowledgment data, never a storage URL.

Storage intents contain a stable asset ID and a public AssetStore-planned URI
before byte I/O. Preservation verifies existing bytes instead of replacing them.
A receipt becomes ready only after every part is durable and its dispatch intent
commits. A source retries the same receive call after failure or lost
acknowledgment. Hosts schedule `repairDispatches` after restart and periodically;
it repairs missing/failed queue submissions through SmrtJobCollection. The host
job restores the captured scope and calls the analysis lifecycle methods. Run
TaskRunner with the `ingestion` queue enabled.

`analyze` appends immutable input/configuration revisions. `claimAnalysis` uses
leases, monotonic fences and attempt budgets; `completeAnalysis` rejects expired
or superseded workers. Terminal attempt output/provenance is preserved. Queue
submission budgets also stop repeated handler failures in visible
`needs_attention`. Reprocessing does not mint actions. `createAction`,
`publishProposal` and `appendPlan` persist explicit intentions and exact attempt
bindings for the later review/execution layer. They do not approve or apply
business operations. Decision/execution/feedback models are persistence
foundations; policy, handler expansion, review and business apply belong to the
later epic children.

`expire` revokes access and pending work before removing bytes and calling
`purgeDerived`. Interrupted deletion is retried by `repairDeletions` and
`sweepRetention`. Minimal receipt/action identities remain, including successful
action result digests; all content-bearing journal payloads are redacted. Private
cleanup locators remain in deletion tombstones so repeated sweeps can remove a
late stale writer's orphan bytes even after the asset owner row is gone. Source
adapters must enforce their configured delivery-age cutoff; expired replay IDs
never become fresh work. Continue running the cleanup sweep for the retained
storage namespace. Upstream source mutation/deletion cannot change copied
originals; explicit privacy deletion revokes every ingestion-derived payload and
requires host cache/index purge.

See [EXTRACTION.md](EXTRACTION.md) for bounded extraction, lease-bound input
snapshots, provider isolation requirements and the extraction corpus.

Validation commands are `pnpm test`, `pnpm test:postgres`, `pnpm test:providers`, `pnpm typecheck` and
`pnpm build` (including built browser import inspection). The PostgreSQL lane
requires the repository's configured database service and never silently skips.
The provider lane exercises local SDK adapters and process isolation; it does not
claim live remote recognition quality. `pnpm test:components` and `pnpm test:e2e`
cover the maintained review surface. `pnpm test:evaluation` checks repository
evaluation tooling contracts; measured held-out quality requires a separately
frozen protocol and an approved aggregate provider budget. See the [behavior matrix](../../docs/test-matrix/3670-ingestion-foundation.md).

## Authoritative review and execution

Configure `IngestionOptions.execution` for policy, immutable previews, authenticated
decisions and idempotent domain execution. See [execution integration](agents/execution.md)
for the public handler catalog, required host authorization/target locks, deployment
migrations and jobs continuation integration. The maintained application reference
in `reference/handlers.ts` creates draft ContentDocuments and attaches retained
evidence through public domain APIs; it is not a published runtime adapter.

## Configured source adapters

The server entry exports `createSourceDeliveryHandler`, `EmailSourceAdapter`,
`WatchFolderSourceAdapter`, and `createVendorWebhookHandler`. Construct a
`SourceBinding` from authenticated host configuration: enabled flag, scoped
`IngestionService`, stable source ID/version, captured authority ceiling,
retention policy, allowed media types and receipt limits. Re-resolve this binding
when grants/configuration change. Source payloads never supply authority.

The reference POST handler authenticates before reading bytes and requires
`Idempotency-Key`. JSON accepts exactly `capturedAt` and one of `text`,
`structured`, or `reference: { owner: 'asset'|'message', id, version }`.
The host's `snapshotReference` must authorize current ownership and return copied
bytes; an absent snapshot fails rather than acknowledging a mutable locator.
Multipart accepts one `file` plus `captureId` (equal to the idempotency key),
`capturedAt`, `captureSource` (`camera`, `native_picker`, `audio`, `document`), and optional
lowercase SHA-256 `sha256`. This reuses mobile's durable UUID Idempotency-Key,
MIME-bearing file part and explicit capture metadata convention. Captures retain
original bytes and a parent metadata evidence record. Configure both the wire
limit `maxRequestBytes` and receipt `maxBytes`/`maxParts`; include
`application/json` in the media allowlist for capture/email metadata. Signature
checks cover PDF, TIFF, PNG/JPEG/WebP and WAV/Ogg/WebM/MP3/MP4 audio; signature
acceptance promises preservation, not extraction support or codec validity.

Email is explicitly opt-in per configured account. `EmailSourceAdapter` takes a
`readMessage` callback compatible with the messages owner's
`EmailAccount.readIntakeMessage(providerLookup, maxBytes, imapIdentity?)` snapshot.
The provider lookup is Gmail message ID, POP3 UIDL, or IMAP RFC Message-ID; it
is separate from the delivery dedupe key. IMAP requires `{ folder, uidValidity,
uid }`: the method selects the mailbox and verifies UIDVALIDITY and returned UID.
Ambiguous sender IDs resolving to another UID fail explicitly. That method connects,
fetches the full message including actual attachment bytes, copies the bytes,
and disconnects. Metadata-only attachments fail explicitly. It never reads an
attachment path supplied by a provider. A host lists provider deliveries using a
stable account-specific locator (for IMAP include folder, UIDVALIDITY and UID),
an explicit revision, and an opaque resumable checkpoint. Same locator/revision
with changed bytes conflicts; an explicit new revision creates a new receipt.
Do not use sender-controlled RFC Message-ID as the sole transport identity.
`receiveBatch` processes in order and stops at the first failure. The host owns
durable checkpoint storage and commits its `acknowledge` callback only after the
adapter has received accepted/duplicate. If checkpoint persistence fails, retry
returns the original receipt. Message/thread/attachment relationships are copied;
credentials and arbitrary headers are excluded. The ordinary `syncFrom` metadata
sync remains separate; `hasAttachments` is never proof of byte preservation.

Watch-folder intake polls only an explicitly configured existing private local
directory. Producers should close their files, preferably publishing with atomic
rename. Two unchanged size/inode/mtime/ctime observations separated by
`stabilityMs` are required, and the interval runs again after claim/restart.
A private `.ingestion-claims/<UUID>/claim.json` intent is synced before atomically
renaming the original into that directory. Keep the directory on one filesystem,
under the host's ownership; symlink inputs are refused. A file descriptor still
held by an uncooperative producer can write after any stability window, so the
producer close/publish protocol is required for immutable input. Accepted or
duplicate receipts move the entire claim to `.ingestion-processed`; do not delete
claims to retry. Polling recovers persisted UUIDs after process death, so receipt
replay deduplicates ready-without-ack. `failure.json` and poll results expose safe
categories while originals remain available. Intent directories without an
original mean death before claim or a competing poll won; the producer original
has not been removed. Operators may remove these empty intents after confirming
no active importer. Keep processed originals according to the host's retention
policy. This adapter does not watch arbitrary paths or start background loops.

Vendor webhooks use a host `verify(request, originalBytes)` callback after bounded
raw-body reading. The callback must verify signature, delivery time/replay window
and account ownership, then return trusted binding and durable delivery identity.
No vendor implementation or hardware driver is selected. All adapters invoke
only receipt preservation, never domain writes, AI tools or external actions.

See [PROPOSALS.md](PROPOSALS.md) for bounded application catalog discovery, durable
interpretation revisions, optional typed decisions and explicit generated preview.

## Human review

Mount the `/svelte` inbox and review components through an authenticated host using
the browser-safe `IntakeReviewHost` DTO contract. See [REVIEW.md](REVIEW.md) for
exact revision-bound callbacks, live evidence access, logical split corrections,
assignment ownership, and the maintained upload-to-domain-result browser fixture.

Optional explicit feedback and scoped example retrieval are documented in
[FEEDBACK.md](FEEDBACK.md). Approval and execution outcomes remain separate from
interpretation correctness; routing policy adoption is explicit and versioned.

Reviewers can start any offered handler for an item (`startReviewerAction`) or
close it as handled without action (`resolveItem`); the published host adapter
wires both as `startAction`/`resolve` and exposes the offered `catalog`. Hosts
with their own transport add the two POST operations behind the same session,
CSRF and reviewer checks as `decide`. The `intake_dispositions` table requires
a manifest migration before upgrading.

## Recipe preview

`ingestion.inbox` and `ingestion.review` declare the user-facing inbox and
review workflows for app discovery. The reference workflow and measured
evaluation are now published, but the evaluation did not meet supported-reference
quality gates and did not establish safety. Automation remains disabled. The
recipes do not configure a source or provider, expose generic CRUD routes, or
enable automatic execution. Mount `IntakeInbox` and `IntakeReview` with an
authenticated `IntakeReviewHost`; [REVIEW.md](REVIEW.md) remains the source of
truth for its scoped callbacks and freshness checks. See the [adoption
checklist](../../docs/evaluation/3677-adoption.md) and [measured
report](../../docs/evaluation/3677-measured-evaluation.md) for the release
limits.

The recipe manifest registers those existing browser components as
`/ingestion/inbox` and `/ingestion/review` routes for a host to mount. The route
metadata does not supply a host, source, provider, or demo fixture, and it does
not change the preview-only status. Neither recipe declares generic model
navigation: the ingestion records have no generated screens, so hosts use the
authenticated route surfaces instead. Both recipes declare `both` runtime: their
components render in a browser, while the authenticated review host and package
dependency closure require a server.

## First analysis and host constraints

`receive` retains evidence and queues the initial dispatch, but does not choose
an extraction configuration. Before a worker can analyze a new item, the host must
call `analyze(itemId, { stage: 'extract', extraction: { configurationRevision,
limits } }, requestId)`, then claim that returned revision and run `extractAnalysis`.
Use a stable request ID for retries. `repairDispatches` repairs queue delivery;
it does not supply the missing extraction request. After extraction, use
`prepareGeneration` and `analyze` to request interpretation.

Retention requires `replayUntil >= expiresAt`; an earlier replay deadline rejects
even a fresh delivery as `expired`. The replay tombstone must outlive retained
source bytes. Set both deadlines explicitly before calling `receive`.

Handler preview `normalizedArgs` must equal the submitted arguments exactly.
It is an integrity assertion, not a normalization hook: defaults or tidying must
happen before submitting args for preview, so review binds exactly what was sent.

Proposal limits must be positive safe integers. `maxHandlers`, `maxCandidates`
and `maxSuggestions` are each capped at 20; `timeoutMs` is capped at 2147483647.
Invalid limits are rejected when constructing `IngestionService`, before receipt
or interpretation. See [REVIEW.md](REVIEW.md) for the published server review host.

## Dispatch route ownership and legacy recovery

A receipt retains a versioned, server-owned `jobTarget` snapshot, and every
analysis dispatch retains the same route. Receipt replay and later analysis
cannot retarget it. `repairDispatches()` filters by retained route before the
calling host's authorization or delivery budget, then rechecks provenance under
the item lock. A failed job for another host sharing the same tenant and
confidential scope neither runs on this host nor blocks its unrelated receipt.
Matching routes still require current access within the captured permission
ceiling; their authorization and queue failures remain visible. Job arguments
continue to contain identifiers only.

Legacy receipts lacking route metadata can use existing recorded job authority
only when all available provenance agrees. A linked job must match the tenant,
ingestion queue, item, dispatch ID and revision exactly. This preserves recorded
job authority, not a reconstruction of the host's historical intention. Conflicting
or malformed provenance fails closed. Deleted jobs are absent provenance: an
existing protected route survives deletion, but without one the route remains
unknown and automatic repair skips it.

`inspectDispatchRoute(itemId)` requires normal read authority and returns a
status, fingerprint and verified target (or null). For genuinely provenance-free
legacy receipts a host may opt into `dispatchRecovery.authorize`. Without this
separate operator authorization callback recovery is disabled. Quiesce legacy
workers and investigate their recorded job history before authorizing recovery;
missing history is not proof of a particular intended handler. Call
`recoverDispatchRoute({ itemId, expectedFingerprint, evidenceRef })` with the
inspection fingerprint and a nonblank evidence reference of at most 512
characters. The target comes exclusively from that service's trusted,
constructor-snapshotted configuration, never from the request.

Recovery acquires the item lock, rechecks current/captured process permissions
and the separate host operator permission, and verifies the exact fingerprint.
It refuses bound, conflicting or stale authority. It appends retained operator,
date, evidence and original fingerprint provenance and binds missing dispatch
metadata atomically; it does not enqueue, alter original receipt/analysis/action
facts, or replace prior provenance. The exact original fingerprint/evidence retry
returns the retained binding, including under concurrent delivery, but still
rechecks both permissions. A different decision conflicts. Once reviewed,
normal matching-host `repairDispatches()` may enqueue work separately. Hosts
without legacy tenants need not configure recovery at all.
