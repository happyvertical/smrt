# Submission and paper workflow

Construct `SubmissionService(db, authorizeLearner, authorizeCatalog, {storage,
storeOptions?, signAsset?})` from trusted server configuration. It extends
`LearnerService`: the same active actor/tenant, memberships, linked person,
directed guardian relationship and host permission checks apply. The host must
allow `education.learner.submit`, `education.learner.grade` or
`education.learner.packet` as appropriate. Grade and packet actions always reject
the learner's own identity, even if the host authorizer returns true.

The protected transaction/auth hooks are internal owning-service extension
points. They are not handler APIs. All public service results remain data-only.
Use the callback's service in `withTransaction`; escaped services are closed.
Submission operations share its serial queue, poison-on-failure behavior and
PostgreSQL enrollment lock. No runtime schema creation occurs.

## Capture and grading

`captureSubmission` takes the learner request, `enrollmentId`, `lessonId`, a
nonempty stable `requestKey`, and `pages` containing `name`, `mimeType` and Buffer
`data`. Each upload becomes a fresh Asset owned by the learner's profile and
exact tenant, joined solely through `SubmissionAsset`. Up to 100 uploads of
25 MiB each are accepted (JPEG, PNG, WebP, or PDF). It atomically creates the
submission/asset metadata and moves only that enrollment's progress to
`submitted`, incrementing attempts once. Caller status, score, grader, asset ID,
and answer-key flags are never patches. Equal request-key/content retries return
the existing submission; altered retries fail. Submitted/review/complete/skipped
progress rejects new captures. Content includes ordered filenames, MIME types,
bytes and notes. Hosts should impose tighter request/body limits as needed.

`captureBlankReference` records a workbook-page scan as immutable
`blank_reference` evidence without advancing completion or creating a grade.
Trusted ingestion scopes each receipt to the exact `enrollmentId` and calls
`assertLessonAssignment` before reading retained evidence; it proves the active
tenant, actor, learner, enrollment, and lesson without creating progress. A
stable `intakeItemId` is claimed once in the durable tenant/item binding table,
then bound to the tenant, learner, lesson, progress, kind and predecessor; an
altered retry fails. The binding is database-unique across enrollments while
ordinary uploads remain unbound. `resubmitSubmission` requires the current completed-work predecessor and
creates a new immutable `completed_work` attempt. Old pages, grades and feedback
remain history; stale predecessors cannot be graded or replaced. A correction may
reopen submitted, review or complete progress, while an AI proposal remains a
non-authoritative Grade until guardian review.

`reviewSubmission` accepts an existing authorized submission and optional score
and feedback. `attestLesson` creates/reuses an Attestation for a matching progress
item without requiring uploads. Both require a verified guardian and create a
new guardian Grade and set submission to `graded`. Ordinary non-workbook progress
becomes `complete`. Workbook-backed progress instead uses its explicit parent
completion decision; grading alone leaves it in progress, including through a
plain SubmissionService instance. Existing explicit completion on the current
attempt is retained. The owning workbook join determines this policy, never a
caller flag.
Omitted/null score is unscored; zero is a real score. The latest guardian grade
wins over auto/AI/instructor proposals, and its score replaces progress's score.
Review history is retained. ExternalCompletion is available for trusted server
persistence; phase-zero learner handlers cannot forge reported scores. Online
submissions and automatic grading are not implemented.

`getSubmission` returns only submission metadata, page asset IDs and the selected
grade. It does not include catalog answers, extracted answers, storage paths,
model objects, or database handles.

`getLatestLessonSubmission` takes the learner request, `enrollmentId` and
`lessonId`, repeats live read authorization and exact enrollment/catalog lesson
scope, and returns the same safe view or `null` when no eligible work exists.
It reads at most one submission for that exact progress, choosing `completed_work`
in `captured`, `needs_review` or `graded` status by `submittedAt DESC, id DESC`.
Blank references, extracting and rejected work are excluded. Committed capture
is retained evidence; it does not assert lesson completion. Hosts select completed
lessons from authorized progress separately. An empty safe page list does not
fall back to older work; asset signing still requires its own live authorization.

## Storage and signed routes

The service creates an AssetRuntime bound to the operation's transaction. It
requires a resolved URI whose filename retains the fresh asset UUID and MIME
extension; custom resolvers may choose its provider/directory but must route
that URI to the corresponding unique file. Shared existing locators are
rejected before preservation or cleanup registration. It plans and persists
that unique asset URI before writing, registering that new
asset for cleanup before the provider can partially write. After rollback,
files are removed through the runtime store. Before deletion, the root database
must confirm that no asset owner committed: uncertain commit/read failures never
cause committed bytes to be removed. Only this operation's newly created assets
are candidates; pre-existing files are never adopted into its cleanup ledger.

Database metadata is atomic; external storage uses compensation, not a database
transaction. If cleanup cannot complete, `SubmissionStorageCleanupError` contains
fresh asset IDs and the original cause. Operators must reconcile those IDs in
the configured `education-page/<id>.<extension>` storage namespace (custom
resolvers must retain their routing audit). A successful retry uses fresh IDs
and cannot delete or reuse orphaned bytes. Process termination may also leave
unreferenced files; hosts need storage orphan reconciliation. Do not suppress
cleanup failures or claim crash-safe distributed atomicity.

`signSubmissionAsset` verifies the submission/enrollment/learner ownership and
its noun join, then verifies the Asset's tenant and learner profile before
calling the configured trusted signer. Claims contain actor, tenant, learner,
enrollment, submission, asset and a five-minute expiry; no static source URI is
returned. The host signs every claim and its serving endpoint must verify the
signature, expiry, current actor/tenant and object authorization before serving.
A bearer URL must never become a cross-family or sibling access bypass.

`signLessonPrintable` signs only the exact authorized `printable` LessonAsset
join for an enrolled lesson. It never accepts an answer-key join and carries the
same tenant, actor, learner and enrollment scope as a submission claim.

## Personal worksheet packets

`splitWorksheetPacket` takes the guardian learner request, exact-owned
`personal-use-copy` `courseId`, PDF bytes and ranges `{lessonId, firstPage,
lastPage}`. Page bounds are inclusive and one-based. Ranges must be in bounds,
disjoint and target distinct Worksheet lessons in that private course. The
50 MiB / 100-range limits are enforced before PDF parsing. `pdf-lib` extracts
actual pages into independent PDFs and records private printable LessonAssets.
All resulting metadata commits together; storage failure compensates new PDFs.
The source packet is not retained. No shared/global course is accepted and no
answer-key join is created. A successful repeated packet upload intentionally
adds another printable version; a failed upload can be retried safely.

Shared integration workflows run on SQLite and real PostgreSQL. Full DuckDB
workflow support remains outside the existing supported schema boundary.

## Private asset boundary

Captured pages and split packet pages use `Asset.accessMode: 'private'` from their
initial insert. Ordinary generated Asset REST/MCP operations cannot list, hydrate,
update or delete them, including through the parent STI model. The service opens
an exact tenant/actor/learner-owner/asset-ID capability only after its normal learner
relationship checks. A host's signed serving route must repeat authorization and
open that exact capability before loading the asset. See the owning
[private asset contract](../../assets/agents/private-assets.md).

Storage must be private (including provider ACLs). Public HTTP(S) source locators
are rejected; a hidden URL alone cannot protect publicly accessible bytes. Apply
the manifest migration adding `assets.access_mode` before deploying this runtime;
legacy ordinary assets retain the public default. Runtime creates no schema.

Private lesson files must already be private Assets in the same tenant. Saving
an answer-key join, or any join under a personal-use-copy course, requires the
host's exact actor/owner/asset capability; a public asset is never automatically
promoted. Packet splitting retains this capability while creating each join.
Persisted course tenant/license and section/lesson parent identity cannot change;
create new structure and explicitly re-author its joins instead. Mandatory
write predicates enforce this even for natural-key adoption and concurrent writes.
Ordinary content and metadata refresh remains supported. This
prevents existing public material being reclassified by moving its parent.

For pre-existing invalid joins, an authorized host must inventory private-material
joins and remove invalid associations, recreate the bytes in private storage as a
new privately classified Asset, then re-author the join under its exact capability.
Do not merely hide the URI, mutate access_mode with raw SQL, or delete shared
public bytes. This repair requires explicit storage/ownership authorization;
normal runtime does not migrate existing records.
