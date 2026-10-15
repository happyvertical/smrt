# Catalog service integration

`EducationCatalogRecipe` is a cookbook declaration, not permission to expose
model CRUD. Hosts construct `CatalogService` with a `CourseCollection`, their
request-bound `TenantCollection`, and a permission resolver adapter. They call
`findVisible({ tenantId, actorUserId })` for a learner projection and pass
`includePrivate: true` only after a guardian-level
`education.catalog.read-private` grant. The service enters
`TenantCollection.withTenantCatalogReadScope` for the Course collection; that
scope is limited to `list`, active family ancestors, and global rows.

Private copies are returned only when their tenant exactly matches the active
request tenant, even with the private-read grant. Ancestor and global private
rows are excluded. Projection also excludes each section, lesson, and asset
join whose tenant differs from the selected course, including malformed stored
links that predate the model save guards.

The shared Tenant model has no family/group kind discriminator. Hosts provision
family tenants and authorize guardian authoring for those tenants; the catalog
enforces a non-null owning tenant, immutable personal-copy tenant/license, and
prohibits `published` personal copies on create and update. Hierarchy position
is not a family classification. This is a new package with no deployed catalog
rows to migrate. If a host imports invalid published personal copies, correct
them to `draft` or `archived` under the original owner before normal saves; never
relabel or promote them. Read ownership checks remain enforced for invalid rows.

The host resolves sections, lessons, and LessonAsset rows only after selecting
an authorized visible course, preserving the course tenant and excluding
`answer-key` relationships from learner projections. Guardian authoring and
asset linking use host handlers that make the same permission decision; no
generated REST, CLI, MCP, or AI operation may bypass those handlers.

Ownership checks use SQL tenant identity predicates so native UUID driver values
cannot reject an unchanged owner. Course-only persistence is exercised on DuckDB;
full catalog child/asset schemas inherit core's current DuckDB rejection of
ON UPDATE CASCADE and self-referential foreign keys. Use SQLite or PostgreSQL for
those schemas; no schema gate is relaxed by this package.

Private-course visibility is a mandatory collection SQL predicate applied before
`limit` and `offset`, including selected-column reads. Caller options cannot
replace that predicate. Video constructor options are reapplied after subtype
field initialization, matching Worksheet. LessonAsset's explicit natural key is
`(tenant_id, lesson_id, asset_id, relationship)`; same-owner and null-owner retries
retain one join identity. Core's cross-owner guard remains in place. A hostile
stored join cannot reserve the legitimate owner's key or be overwritten by it.
