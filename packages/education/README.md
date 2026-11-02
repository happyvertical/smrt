# @happyvertical/smrt-education

Preview education catalog models and authorized catalog reads for s-m-r-t.
The package represents courses, ordered sections, lessons, and lesson-owned files.
It supplies catalog structure and authorized learner planning/progress workflows.
Applications authenticate actors and decide guardian permissions.

Homeschool groups use `GroupSharingService`, with the optional
`education.supervisor` recipe. Its read-only reader and comment services remain
internal so hosts cannot accidentally bypass the owning transaction lifecycle.
Groups have independent users tenants; parents approve links to existing family
learners and choose a versioned sharing policy. The closed services recheck live
session, role, membership and policy on the supplied database executor. Family
work and revision-bound comments remain retained after leaving a group.
See the [group sharing contract](agents/group-sharing.md) for the required host
authorizer, private media delivery, facet semantics and migration/test matrix.

Guardians author courses with `CourseAuthoringService`: append-only course and
lesson revisions, a reviewed release that materializes immutable lessons,
reversible archive, and recorded enrollment pins and upgrades. See the
[course authoring contract](agents/course-authoring-service.md).

## Install

```sh
pnpm add @happyvertical/smrt-education
```

Use the package with the core, users, profiles, tenancy, and assets packages.
Apply application migrations before using the catalog collections.
Runtime catalog operations do not create application schema.

## Models and collections

| Model | Purpose |
| --- | --- |
| `CourseSource` | Host-managed adapter policy and sharing ceiling |
| `Course` | Course metadata, license, status, and optional owning tenant |
| `ExternalCourse` | External course subtype sharing the Course table |
| `AuthoredCourse` | Authored course subtype sharing the Course table |
| `CourseSection` | Ordered section belonging to a course |
| `Lesson` | Ordered lesson belonging to a section |
| `Reading`, `Video`, `Worksheet`, `Exercise` | Lesson subtypes |
| `LessonAsset` | Lesson-owned file join with a relationship such as printable or answer-key |
| `Learner` | A required User/Person identity and guarded settings in one family tenant |
| `Curriculum` | A learner plan for a distinct period |
| `Enrollment` | One course in a curriculum |
| `LessonProgress` | One lesson in an enrollment, with nullable score and separate history |

Each exported model has a corresponding exported collection.
Course and lesson subtypes use single-table inheritance.
Sections and lessons sort by `sortOrder`, with identifier ordering for ties.
Lesson files belong in `LessonAsset`; lesson subtypes do not carry asset-id fields.

## Basic integration

1. Create the course, section, lesson, and lesson-asset collections with the
   application's database executor.
2. Supply those collections, a request-bound `TenantCollection`, and the host's
   actor-bound permission resolver to `CatalogService`.
3. Enable tenancy and establish the authenticated actor's active tenant context.
4. Call `findVisible` with that tenant's canonical identifier and the actor's
   user identifier to list the ordinary catalog.
5. Call `projectCourse` with the same context and a visible course identifier
   to obtain its ordered sections, lessons, and allowed asset joins.

The [catalog service integration tests](src/__tests__/catalog-service.test.ts)
provide executable examples of collection setup, `withTenant`, and service reads.
See the [integration contract](agents/catalog-service.md) for host responsibilities.
The authorizer must make a trusted server-side permission decision for the actor;
a caller-supplied boolean is not a substitute for authentication or authorization.

## Privacy and ownership

Ordinary catalog reads can include the active tenant, its ancestors, and globals.
The supplied tenancy capability widens only the allowlisted catalog list reads.
It does not grant generic get, write, raw query, sibling, or descendant access.

Personal-use copies require an owning tenant and cannot be published.
Their owner and license kind cannot be changed after creation.
`includePrivate` requires a separate host grant and returns only the active
owner's personal copies, never an ancestor's or global private copy.
The shared Tenant model has no family/group discriminator; hosts provision
family tenants and authorize their guardian workflows.

Learner projections remove worksheet answer URLs and answer-key asset joins.
`includeAnswerKeys` requires a separate host permission.
Every projected child must have the selected course's exact owning tenant.
Stored inconsistent section, lesson, and asset links are excluded.
Generated REST, CLI, MCP, and AI operations are closed for these models.

## Learner workflows

Create `LearnerService` with the application's root database executor and trusted
learner/catalog authorizers. In the authenticated actor's exact `withTenant`
context, an authorized guardian can `createCurriculum` and `enroll`; a learner
can `getLearner`, `startLesson`, and `listProgress` for their own work.
Guardian access requires a same-tenant directed `ProfileRelationship` plus the
host's permission decision. Sibling membership does not grant access.

Repeated starts preserve the existing progress, including attempts and scores.
A new curriculum/year creates a distinct enrollment and fresh progress history.
An unscored lesson has `bestScore: null`, distinct from zero. The service does
not accept score or completion patches; `SubmissionService` owns guardian grading.
Use `withTransaction` and its callback service to compose atomic operations.
Results are plain data views, so no transaction-bound model handle escapes.

The [learner integration contract](agents/learner-service.md) describes required
identity provisioning, catalog permissions, supported workflows and limitations.
The [executable learner workflows](src/__tests__/learner-workflows.ts) test this
integration on both SQLite and PostgreSQL.

## Submissions and worksheet packets

`SubmissionService` captures tenant-owned uploads, reviews or attests work with
optional guardian scores, signs authorized asset claims, and splits private
PDF packets by page range. It reuses learner ownership and transaction checks.
See the [submission integration contract](agents/submission-service.md) for
inputs, retry rules, signing requirements and external-storage compensation.

## Source imports

`SourceImportService` imports Easy Peasy pages as private family pointers after
explicit host terms acceptance. Hosts inject the page fetcher and authorize the
active actor, family/group destination and licensing evidence. Re-import refreshes
URLs in place without deleting lessons or learner history. No lesson text or PDFs
are mirrored. See the [source integration contract](agents/source-import.md) and
[source behavior matrix](../../docs/test-matrix/3967-education-sources.md).

## Recipes

`EducationCatalogRecipe` declares `education.catalog`; `EducationLearnerRecipe`
declares `education.learner`.
Its course navigation and model declarations support application composition.
A recipe does not grant permission to expose model CRUD or private material.

## Database support and validation

SQLite and PostgreSQL exercise catalog persistence and child ownership guards.
The real ancestor hierarchy integration is exercised on SQLite.
DuckDB tests cover Course-only persistence: existing core DDL gates reject
catalog child update-cascade and Asset/Tenant self-referential foreign keys.
Use SQLite or PostgreSQL for full catalog schemas; those gates remain intact.

Run the package's `test`, `test:postgres`, `typecheck`, and `build` scripts.
The [behavior matrix](../../docs/test-matrix/3966-education-catalog.md) records
regressions, dialect coverage, and the existing DuckDB setup limitations.

## Related documentation

- [Package agent guidance](AGENTS.md)
- [Core persistence](../core/README.md)
- [Users and tenant hierarchy](../users/README.md)
- [Tenant isolation](../tenancy/README.md)
- [Assets](../assets/README.md)


### Public first-edition Illustrative Mathematics

`createPublicIllustrativeMathematicsFirstEditionAdapter({ fetch })` returns both
`CatalogSyncAdapter` and `CatalogAcquireAdapter`; `fetch` is optional and defaults
to the standard global Fetch API. Use the same factory for discovery and explicit
private acquisition through `CatalogAcquisitionService`. No credential, mounted
provider module or PDF fetch is needed for discovery. Apply the additive catalog
representation column migration before using this version.

The declared metadata scope is public artifact links on the fixed official CMS
host, with explicit student/family labels in the first-edition Kendall Hunt
K–5, 6–8, and high-school teacher/family hierarchy, including Algebra 1 Supports
and linked Spanish counterparts. Traversal starts at the official homepage and
fixed curriculum roots; it follows direct course, unit, resources,
family-materials, and lesson-preparation links. An icon or file-name label never
establishes the observed format or grants role/rights. Teacher guides, answers,
assessments, teacher presentations, login-only links, unknown roles, HTML-only
student lessons, external-host artifacts and AccessIM/v.360 remain outside this
metadata scope. External links are not followed or HEADed. Known PDF, ZIP and
DOCX MIME types are retained. Otherwise eligible artifacts with an absent or
unrecognized Content-Type remain explicit unknown metadata with acquisition
denied; malformed MIME or invalid validators pause enumeration rather than
silently omitting an artifact. Only PDF bytes can be acquired.
Completion means this declared scope only. Policy omissions appear in the
bounded, invocation-local `CatalogSyncReport.exclusionSummary`, rather than the
durable failure ledger.

Each `enumerate` reads one HTML page (2 MB maximum) and at most four asset HEADs.
It never GETs asset content. Known PDF/ZIP/DOCX HEAD metadata is retained even when
the file exceeds the PDF acquisition cap. Missing/weak validators, malformed MIME
or access/transport failures pause the page without advancing. Each observed record has
optional `representation` metadata with actual `format`, `mediaType`, positive safe
`byteLength`, strong ETag/Last-Modified `validators`, and `acquisition` capability.
A PDF is `supported` or `size-limit` with its observed `maxBytes`; ZIP and DOCX are always
`unsupported-format`. An unknown representation has `format: 'unknown'`,
`mediaType: null` for an absent header or the actual unrecognized canonical MIME,
`availableFormats: []`, and `acquisition.status: 'unknown-format'` with a
`missing-content-type` or `unrecognized-content-type` reason. Its observed size,
validators and legal evidence remain intact; the evaluator denies new acquisition.
Unknown v2 revisions encode MIME absence or the observed token explicitly.
The source icon does not override the actual MIME. Version-1 JSON cursors contain the remaining validated
hierarchy paths and an artifact offset plus source fingerprint when needed;
persist the returned cursor unchanged. A fresh adapter can resume it. The cursor
is capped at 64 KB and 384 pending paths; source pages are capped at 128 children
and artifacts. Exceeding a bound, changing source metadata during a chunked page,
or a provider failure pauses with the current cursor, never a terminal success.
Normal `CatalogSyncService` invocation page budgets yield an unpaused, incomplete
checkpoint without inventing a source failure; resume it to complete the same generation.

The source fingerprint is SHA-256 of canonical JSON containing the canonical
path and parsed children, artifacts (asset ID, exact normalized label, allowed
role), exclusions, source attribution, notices, license decision, and title, in
source order. It excludes scripts, comments and transient CSRF markup. This is
necessary because official page weak ETags change for each anonymous request.
Acquisition rechecks that fingerprint, exact asset identity, role and license
before requesting bytes. The PDF revision additionally pins the strong ETag,
length and Last-Modified. A conditional PDF GET must return the identical
validators, PDF content type, exact declared/streamed length and `%PDF-` signature;
the adapter hashes the bytes with SHA-256. The generic service retains attribution
and image/trademark notices and provides tenant, selection and idempotence checks.

`timeoutMs` bounds the entire call, including streaming (default 20 seconds,
maximum 60 seconds). `maxPdfBytes` bounds acquisition only and defaults to 32 MiB
(maximum 64 MiB). Changing it does not change an existing PDF content revision. Requests
use fixed official hosts and strict paths, reject redirects, and carry no source
credentials. Rate limiting returns a resumable pause with Retry-After information;
hosts must honor that delay before resuming rather than loop immediately.

License evidence comes from each exact official source page's attribution and
CC BY 4.0 footer, with retrieval time and retained exceptions. The official
[terms §7.1](https://illustrativemathematics.org/terms-of-use/) distinguish the
first edition's CC BY 4.0 curriculum from the separate v.360 terms in §7.2.
No v.360 grant is inferred.


Public IM PDF roles are local: a table artifact must belong to the same closed
row as its explicit first-cell label; a non-table artifact must be directly in
an `im-c-row__flex-resource` block with exactly one local `h3`/`h4` label.
Missing, ambiguous, nested, or cross-section labels are excluded. A preceding
student heading cannot authorize a separate teacher/unknown block. Structural
parsing is bounded to 50,000 tags and 256 open elements. Family unit pages may
follow their directed same-unit `family-materials.html` edge; family-materials
leaves never follow reverse unit navigation.

Adapters use `policyExclusions` for normal role/license/format/scope omissions;
IM emits page-wide omissions only on artifact offset zero and each artifact's
omission only in its processed chunk. `exclusions` retains its operational error
meaning: a current error/pause cannot advance the cursor, write returned partial
resources, withdraw unseen rows, or report completion. The report's
`exclusionSummary: { total, byCode: [{ code, count }], otherCount }` counts only
pages processed in that invocation, retains at most 32 public code tokens, and
is never stored in the checkpoint. Hosts may aggregate these invocation-local
counts explicitly; they are not full-generation coverage totals.

Durable failures remain the existing JSON array, compacted to 31 recent code
diagnostics plus an explicit overflow entry. Each entry's optional `count`
preserves occurrence totals; `omittedDetailCount` explicitly counts occurrences
whose diagnostic details were compacted/truncated. Messages and diagnostic
cursors are bounded to 512/256 characters; the actual resume cursor is preserved.
Missing legacy counts mean one; malformed counts are explicitly marked and
counted once. Unsafe integer totals fail closed. `failureSummary` distinguishes
`historicalCount` from this invocation's `currentCount`, with total and omitted
detail counts. Historical mixed-policy/error entries are retained as audit
history without guessed reclassification. An old coarse six-grade checkpoint
with no cursor starts the new adapter at its root, preserves its imported count
and history, and may complete/withdraw only at the new traversal's actual terminal
page. History alone does not create an active pause.


Before creating a new selection or writing files, hosts call
`evaluateCatalogAcquisitionCapability(resource, format, { maxBytes })` on the
fresh authoritative record inside their transaction, separately from legal
`CatalogPolicy` authorization. The optional current limit can tighten the
persisted limit, never loosen it. Denials distinguish unknown format, unsupported
format, size limit, unavailable format and invalid representation metadata. It does not
control printing already pinned bytes. `CatalogAcquisitionService` repeats the
capability guard for new fetches after its existing pinned-acquisition return;
current actor, selection, revision, available-format and legal checks still precede that return.
The adapter independently revalidates format, size, validators and content bytes.

`normalizeCatalogRepresentation(unknown)` parses persisted JSON and returns a
validated defensive copy. Missing, null and serialized JSON null mean legacy
absence; the evaluator reports `verification: 'legacy'` without inventing measured
support, and adapters still enforce their strict acquisition checks. Malformed
present metadata throws `CatalogRepresentationError`; the evaluator explicitly
denies `invalid-representation-metadata`. Never catch this error and replace it
with absence in a read projection. `CatalogResource.getRepresentation()` and
`setRepresentation()` use the same guard. `CatalogDatabaseSyncStore` persists the
field and `CatalogReadService` preserves it in its metadata DTO. The nullable TEXT column migration leaves existing rows SQL NULL; new model/store
values use serialized JSON null. Both mean legacy absence; runtime code
does not create or alter schema.


### Recovering an old partial inventory after a semantic scope change

Including previously omitted non-PDF links changes the canonical page semantics.
This causes a one-time catalog revision change even when the publisher's HTML
and PDF validators did not change. PDF v1 encoding remains unchanged, but its
page fingerprint can change. An old chunk cursor must pause on a fingerprint
mismatch; never reinterpret its artifact offset against the expanded inventory,
remove its fingerprint, or mark it complete. An old coarse checkpoint with no
cursor already starts root discovery naturally and needs no reset.

There is no ordinary UI or cross-process restart operation. The following is an
**operator-only procedure requiring proven quiescence**. Fence new catalog
requests, disable/drain or terminate every catalog producer, job and automated
continuation across **every pod/process**, and await all in-flight provider
operations/writers, including successful and failing callbacks. Keep new writers
fenced until the reset finishes. Browser Stop or a paused status alone is not
quiescence: a late success or failure can overwrite a reset or withdraw old-run
rows. The fresh run-ID check below does not provide concurrent CAS protection.

With trusted `db`, `providerId` and the operator's `expectedRunId` (explicit
`undefined` only for a legacy generation without one), use the existing public
store API after establishing that precondition:

```ts
const store = new CatalogDatabaseSyncStore(db);
const current = await store.getCheckpoint(providerId);
if (!current || current.complete || !current.paused ||
    current.runId !== expectedRunId) {
  throw new Error('Expected paused catalog generation is no longer current.');
}
await store.saveCheckpoint({
  ...current,
  runId: globalThis.crypto.randomUUID(),
  cursor: undefined,
  importedCount: 0,
  complete: false,
  paused: false,
  pauseReason: undefined,
  failures: structuredClone(current.failures),
});
```

Record the quiescence and reset in the operator's audit. This changes traversal
state only: retain all source rows, bounded failure history/counts,
`lastSuccessfulAt`, selections, acquisitions and private files. Do not delete
rows/bytes or claim completion. After writers are re-enabled, ordinary sync
starts at the current adapter's root under the fresh run ID; rows remain until
an actual successful terminal generation permits withdrawal. A subsequent real
source failure still pauses and cannot authorize withdrawal.

Old catalog selection/acquisition retries may be stale after the one-time
semantic revision change and still require current revision/rights checks.
Previously assigned/materialized private bytes are not changed or deleted by
catalog discovery; their private printing path is independent of later catalog
revisions. A new selection through the current adapter keeps its revision and
cached acquisition across a same-adapter refresh with unchanged source semantics.
