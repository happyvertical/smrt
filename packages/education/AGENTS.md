# smrt-education

Catalog objects are optional-tenant scoped and have no generated REST, CLI, MCP,
or AI surface. Applications use `CatalogService`, supplying their actor-bound
authorization decision and the trusted `TenantCollection.withTenantCatalogReadScope`
adapter from smrt-users. Catalog authorization receives the exact shared collection
executor; live session/permission checks must use that executor. That read scope may widen only an allowlisted catalog
collection's `list` to self, ancestors, and globals; it never authorizes a get,
write, raw query, sibling, or descendant read.

`personal-use-copy` courses and all `answer-key` lesson assets are private
family material. Do not publish them, promote them, or expose them through a
learner-facing result. `LessonAsset` is the sole owner join for lesson files;
do not add asset-id fields to lesson subclasses.

Learner objects require exact tenant ownership and close generated surfaces.
`LearnerService` owns actor/resource authorization and transactional planning and
start-progress; see [learner contract](agents/learner-service.md). Guardian
relationships require a host decision about their type and effective terms.
Never expose direct collection writes as learner handlers, reset progress on a
retry, or treat an unscored nullable decimal as zero.

Submission capture, guardian grading and private PDF packet splitting use
`SubmissionService`; see [submission contract](agents/submission-service.md).
Keep asset metadata on the same transaction and compensate only newly planned
files after rollback; never expose source URIs or accept learner grade patches.

Validation: `pnpm --filter @happyvertical/smrt-education test`,
`test:postgres`, `typecheck`, and `build`.

Physical workbook capture, immutable assessment/feedback history and descriptive
evidence use [WorkbookService](agents/workbook-service.md). Keep provisional
sharing separate from guardian Grade authority. Photo-first receipt/context
capture uses [WorkbookPhotoService](agents/photo-intake.md); covers/references
never create learning evidence, and blank exercises need explicit work intent.

Revisioned authored courses, release, archive, enrollment pins and licence use
[CourseAuthoringService](agents/course-authoring-service.md). Keep history
append-only, require request keys, and never weaken personal-use-copy rules.

Generation proposals into new draft revisions and revision-bound educational
review use [CourseGenerationReviewService](agents/course-generation-review.md).
Keep supplied content unless a decision is recorded; reviews carry no score.

Immutable questions, answer keys/rubrics, stable learning objectives, worksheet
render ids and exact-revision references use [QuestionAuthoringService](agents/question-records.md).
Keep keys out of learner bundles; a missing key stays null. `attachGeneratedPrintable`
stores the rendered PDFs; the guardian copy is always an `answer-key`, never `printable`.

Source import: [host boundary and transaction contract](agents/source-import.md).
`SourceImportService` requires host opt-in, matching active actor/tenant and
explicit licensing authorization; never add a system/global write bypass.

Family-owned unassigned originals and audited learner adoption use
[FamilyIntakeService](agents/family-intake.md). Keep family source scope immutable;
assignment alone never creates learning history or grants learner inbox access.

Publisher catalog previews use [the preview contract](agents/catalog-previews.md).
Keep independent image rights and source revisions; serve via `CatalogPreviewService`
with live actor/tenant authorization, never direct provider image URLs.

Enrollment Plan projections and guardian-only parent notes use
[the Plan contract](agents/learner-plan.md). Keep awaiting review separate from
Continue; note authority/provenance never grants learner access or learning evidence.

Homeschool group sharing uses [GroupSharingService](agents/group-sharing.md),
its read-only reader and revision comment service. Group tenants never become
family ancestors or guardians. Enumerate only the group-owned opaque roster index,
then revalidate each exact family edge and current policy. Media delivery must call
the reader on every request; signed storage URLs are not a sharing grant. Saved
parent comment visibility applies on every child read. Progress with feedback
disabled contains counts only, never correctness, scores or concept labels.
