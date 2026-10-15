# @happyvertical/smrt-education

Preview education catalog models and authorized catalog reads for s-m-r-t.
The package represents courses, ordered sections, lessons, and lesson-owned files.
It supplies catalog structure and authorized learner planning/progress workflows.
Applications authenticate actors and decide guardian permissions.

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
not accept score or completion patches; grading is a separate future workflow.
Use `withTransaction` and its callback service to compose atomic operations.
Results are plain data views, so no transaction-bound model handle escapes.

The [learner integration contract](agents/learner-service.md) describes required
identity provisioning, catalog permissions, supported workflows and limitations.
The [executable learner workflows](src/__tests__/learner-workflows.ts) test this
integration on both SQLite and PostgreSQL.

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
