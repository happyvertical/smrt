# smrt-education

Catalog objects are optional-tenant scoped and have no generated REST, CLI, MCP,
or AI surface. Applications use `CatalogService`, supplying their actor-bound
authorization decision and the trusted `TenantCollection.withTenantCatalogReadScope`
adapter from smrt-users. That read scope may widen only an allowlisted catalog
collection's `list` to self, ancestors, and globals; it never authorizes a get,
write, raw query, sibling, or descendant read.

`personal-use-copy` courses and all `answer-key` lesson assets are private
family material. Do not publish them, promote them, or expose them through a
learner-facing result. `LessonAsset` is the sole owner join for lesson files;
do not add asset-id fields to lesson subclasses.

Validation: `pnpm --filter @happyvertical/smrt-education test`,
`test:postgres`, `typecheck`, and `build`.
