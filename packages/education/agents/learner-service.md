# Learner service boundary

`Learner`, `Curriculum`, `Enrollment`, and `LessonProgress` require an exact
owning tenant. Their generated API, CLI, MCP, and AI operations are closed.
The corresponding collections and model saves are trusted server persistence
APIs, not request handlers. Hosts must not wrap them in generic learner CRUD.

## Identity and authority

Provision a Person Profile, a linked User, and an active Membership before
creating a Learner with explicit `tenantId`, `userId`, and `profileId`. User
email is optional. Learner identity cannot be reassigned after creation.
Guardianship is a directed `ProfileRelationship`, not a Learner `parentId`.
The shared Tenant has no family discriminator: “family” means a tenant that
the host has provisioned and authorized for this purpose.

Construct `LearnerService(db, authorizeLearner, authorizeCatalog)` with one
root database executor and trusted server-side authorizers. Enable tenancy
and establish `withTenant({ tenantId, userId }, callback)` from authenticated
credentials. Every request must match that active actor and tenant exactly;
missing context, spoofed identifiers, and super-admin bypass contexts fail.
Both the actor and learner must hold active memberships in that exact tenant.
A learner's User must still link to the learner's Person Profile.

For a different actor, supply `guardianRelationshipId`. The service checks
that this relationship is owned by the active tenant and directed from the
actor's User Profile to the learner's Profile. `authorizeLearner` receives
`own`, `action`, and the verified `relationshipTypeId`; the host must check
that the type represents guardianship, its terms are effective, and that
its permission policy allows the action. An arbitrary relationship is not a
guardian grant. Missing relationships and host denials/exceptions fail closed.
The authorizer also receives `executor`, the service's active database
executor. Host policy reads, including relationship and revocation checks, must
use that executor so they share a `withTransaction` or `withExecutor` boundary.
Same-tenant membership alone never grants sibling access.

## Supported workflow

- `getLearnerSetupStatus({ tenantId, actorUserId, learnerUserId })` is a
  host-authorized onboarding probe for an active tenant member. It returns only
  `{ needsSetup }`; it neither returns learner or relationship data nor grants
  relationships. The host authorizer receives `education.learner.setup`, the
  target user id, and the active executor. `provisionLearner` remains the write
  path and still requires a directed guardian relationship.
- `getLearner` returns authorized learner metadata and parsed settings.
- `createCurriculum` creates a **planned** curriculum for an authorized guardian.
  A learner cannot plan their own curriculum. Title is required.
- `enroll` requires that guardian authority and a matching tenant curriculum.
  It returns the existing enrollment for the same curriculum/course unchanged.
- `startLesson` allows the learner or authorized guardian to create their own
  enrollment's lesson progress in `in_progress`. It derives learner identity
  from the validated enrollment. Repeated starts return existing state without
  resetting counters, scores, completion, or timestamps.
- `listProgress` reads only the validated learner/enrollment and lessons still
  visible in that enrollment's course. Inconsistent persisted links fail
  closed or are omitted from the list.

Service results are data-only views, with no persistence or database methods.
Extra request fields are never model patches: a learner cannot set score,
attempt count, or completion status through this API. Curriculum activation,
completion transitions and dashboard aggregation are not supported by this
base service. SubmissionService extends its owning transaction/auth boundary for
capture and guardian grading; see [submission contract](submission-service.md).
Direct model writes require trusted authority.

Catalog visibility and child ownership reuse `CatalogService` on the same
executor. Learner operations request private-inclusive catalog access, so the
host catalog authorizer must permit both `education.catalog.read` and
`education.catalog.read-private` for the supported enrollment workflow.
Private copies remain restricted to the exact owner. The service constructs a
whitelisted catalog request; caller options and answer-key flags are discarded.
Answer keys are never requested or returned. A catalog grant does not grant learner authorization.

## Transactions and history

`withTransaction(async transaction => ...)` composes service operations on the
callback's transaction-bound service. Use that service for every operation in
the unit. Throwing rolls back its curriculum, enrollment, and progress writes.
The callback's service closes when the transaction ends and rejects later calls.
A failed mutation poisons the unit even if the callback catches its rejection;
queued mutations are cancelled. Callback failure stops pending work and waits for
already-running mutations to settle before rollback releases the executor. On
success, already-enqueued mutations finish before commit. Do not retain the
callback's service beyond the callback. The constructor
accepts a root database; callers composing work use this method instead of
passing an unmanaged transaction handle.

PostgreSQL locks the parent curriculum/enrollment row before find-or-create.
Embedded writes use the core transaction queue. Concurrent mutations inside
one callback transaction are ordered on that connection, so duplicate starts
within a `Promise.all` also return the same row. Database natural-key constraints
arbitrate enrollment `(tenant_id, curriculum_id, course_id)` and progress
`(tenant_id, enrollment_id, lesson_id)` identities. Explicit storage conflict
keys include the tenant prefix because core does not add it to explicit keys.
The logical keys required by #3968 remain curriculum/course and enrollment/lesson:
immutable parent ownership and parent-tenant checks reject any second tenant
for the same parent. The storage prefix cannot create a second valid logical row. Ordinary repeated and concurrent calls
return one row; an aborted workflow can be retried. No in-memory process lock
is used for PostgreSQL concurrency.

A new year is a new curriculum and enrollment, producing independent progress.
Unscored `bestScore` persists as null; score zero is a real score. Scores are
nullable decimals in [0,1]; counters are nonnegative safe integers. Settings
are stored as JSON text and accessed through guarded `getSettings`/`setSettings`.

The shared executable workflows in `src/__tests__/learner-workflows.ts` run
against SQLite and PostgreSQL, including actor/resource/context denial,
concurrent creation, rollback, history preservation, and zero/null scores.
Full DuckDB schemas remain blocked by existing upstream DDL restrictions;
no full learner workflow support on DuckDB is claimed.
