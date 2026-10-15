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

`reviewSubmission` accepts an existing authorized submission and optional score
and feedback. `attestLesson` creates/reuses an Attestation for a matching progress
item without requiring uploads. Both require a verified guardian and create a
new guardian Grade, set submission to `graded` and progress to `complete`.
Omitted/null score is unscored; zero is a real score. The latest guardian grade
wins over auto/AI/instructor proposals, and its score replaces progress's score.
Review history is retained. ExternalCompletion is available for trusted server
persistence; phase-zero learner handlers cannot forge reported scores. Online
submissions and automatic grading are not implemented.

`getSubmission` returns only submission metadata, page asset IDs and the selected
grade. It does not include catalog answers, extracted answers, storage paths,
model objects, or database handles.

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
