# Catalog service integration

`EducationCatalogRecipe` is a cookbook declaration, not permission to expose
model CRUD. Hosts construct `CatalogService` with a `CourseCollection`, their
request-bound `TenantCollection`, and a permission resolver adapter. They call
`findVisible({ tenantId, actorUserId })` for a learner projection and pass
`includePrivate: true` only after a guardian-level
`education.catalog.read-private` grant. The service enters
`TenantCollection.withTenantCatalogReadScope` for the Course collection; that
scope is limited to `list`, active family ancestors, and global rows.

The host resolves sections, lessons, and LessonAsset rows only after selecting
an authorized visible course, preserving the course tenant and excluding
`answer-key` relationships from learner projections. Guardian authoring and
asset linking use host handlers that make the same permission decision; no
generated REST, CLI, MCP, or AI operation may bypass those handlers.
