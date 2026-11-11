<!-- Module doc for packages/core/AGENTS.md. Linked from the Modules table there. -->

# Collection reads

This module covers bounded collection reads beyond the basic query contract in
`packages/core/AGENTS.md`.

## Projections and related rows

`list({ select })` uses SMRT field names, maps them to database columns, and
returns plain rows without hydrating objects. It composes with `where`,
`orderBy`, `limit`, and `offset`, runs normal `beforeList`/tenant interceptors,
and is limited to column-backed fields; it cannot combine with `include`.

## Linked display names

A model can name its records through one `foreignKey` or qualified
`crossPackageRef`, without maintaining a second copy of the name:

```typescript
@smrt({ display: { label: {
  via: 'profileId', field: 'name', fallback: 'Unnamed customer',
} } })
```

`via` is the local persisted reference field, `field` is a persisted scalar on
its target, and `fallback` is a required non-empty human-readable string.
Dotted paths and extra options are rejected. The build validates the owning
package's target manifest (declare the target package as a dependency). Both
ends must be public: sensitive, transient, relationship-valued and
`readPermission`-gated label fields are refused. Runtime repeats these checks
against the effective target, so an app replacement cannot weaken them.
`displayLabel` / `display_label` is reserved on models with this declaration.

The manifest carries `displayLabelProjection` and
`displayLabelField: 'displayLabel'`; web collection definitions add a read-only
text field. Collection `list()` and `get()` expose `displayLabel` on its JSON/public DTO. `where: { 'displayLabel like': '%Maya%' }`,
`orderBy: 'displayLabel ASC, id ASC'`, and `count({ where })` use the same SQL
LEFT JOIN. Filtering, ordering and pagination happen in the database, with one
data SELECT per list page, independent of row count. Target lookup uses its
primary key's existing index; no new persisted column or index is needed.
Plain `select` projections remain restricted to persisted columns.

The join resolves the effective qualified target (including same-name app
subclasses), runs the target collection's `beforeList` authorization/tenant
scope and STI branch predicate, and never hydrates target records. Like other
plain projections, target `afterList` hooks do not run; row authorization must
be expressed in `beforeList`. Source/target tenant owners must match exactly,
including global-to-global links; a global source cannot reveal a tenant-owned
name. Missing, invisible, cross-owner, null or blank targets return the declared
fallback. There is no cross-tenant option on the projection. Explicit reviewed
cross-tenant workflows continue to use `loadRelated('profileId', { allowCrossTenant: true })`.

The label is a snapshot of the read, never a writeable model field. Saving a
hydrated object excludes it from persistence, and REST strips label input.
Fresh, unqueried instances do not have a projected label; reload through the
collection after a write. Projected collection reads bypass the row cache and
REST uses a body-hash ETag so target renames cannot leave stale names behind.
Generated SvelteKit list routes share `parseRestListWhere()` with runtime REST,
honor explicit `orderBy` with the existing stable default, and count the filtered
rows. Their tenant predicate still applies to client-supplied filters. Generated
list/get routes use the same body-hash rule and strip computed label writes.

### B1b test design

All tests use in-process SQLite and one database handle per fixture. No
projection writes exist, so rollback/idempotency cases are N/A; the save case
proves computed values never enter persistence. PostgreSQL/DuckDB execution of
the new join remains unverified.

| Behavior / reachable trigger | Positive | Negative / failure | Actor and executor | Contract / level | Command |
| --- | --- | --- | --- | --- | --- |
| Build a display declaration | One cross-package hop survives manifest/web generation | Missing/gated/sensitive/transient target, malformed hop, unknown option, reserved field rejected | Build author / scanner | Metadata / integration | core `pnpm test` |
| List/get/search/sort/count | Names filtered and ordered before a page; one SELECT for differently sized pages | Missing/blank link gets declared fallback; save never writes name | Collection caller / shared SQLite handle | DTO, pagination, query count / integration | core `pnpm test` |
| Target authorization | Visible owner A/B names match active scope | Other-owner/global links and hidden rows yield fallback; policy errors propagate | Tenant A, B, no active tenant / scoped SQL | Information boundary / integration | core `pnpm test` |
| Replacement target and source | App Customer projects app Profile title and custom field | Provider-only and existing ancestry/CRUD controls remain passing | App / public fixture migrations | Qualified relationship identity / integration | core `pnpm test` |
| REST freshness / input | Profile rename changes response and ETag | Caller label cannot become persisted input | REST caller / same SQLite executor | HTTP representation / integration | core `pnpm test` |
| Commerce canary | Customer's REST list/get/search source reads Profile name | Missing Profile displays Unnamed customer | Signed-in tenant owner / shared SQLite handle | REST → screens source / integration | commerce `pnpm test` |

## Bounded STI discriminator scopes

An STI child collection reads its own qualified `_meta_type` and all registered descendants by default. A migration that must read registered sibling types may opt into an
explicit allowlist:

```typescript
await impressionEvents.list({
  stiScope: {
    types: [
      '@anytown/advertising:AdImpression',
      '@anytown/advertising:LegacyAdImpression',
    ],
  },
  orderBy: 'created_at ASC',
  limit: 100,
});
```

`stiScope.types` accepts 1–50 unique, qualified, registered types, all sharing
the child collection's STI root. Empty, simple-name, unknown, duplicate,
unrelated, and non-child scopes fail at the collection boundary. The option is
supported by `list()`, `count()`, `counts()`, `facets()`, and
`listWithLatestRelated()`. These methods retain their normal field validation,
projection or polymorphic hydration, pagination and cache-key construction;
normal read and tenant interceptors still run and are ANDed with the allowlist.
Point reads through `get()` remain within the child branch; use a bounded
`list({ where, limit: 1, stiScope })` migration read when sibling hydration is
required.

Raw SQL helpers can use `getStiChildMetaTypes()` to obtain the same branch
discriminator set. The older `getStiChildMetaType()` returns only the class's
own discriminator for callers that intentionally require an exact subtype.

For one child per parent, use
[`latest-related.md`](latest-related.md). It uses a portable ranked CTE,
declared primary keys, adapter-specific offset-only syntax, explicit aliases,
and hydrates only the visible parent page.

## Facets, counts, and read plans

`collection.facets({ fields, where })` runs one bounded `GROUP BY` per requested
field and returns `{ field, values: [{ value, count }] }`. It accepts at most 20
fields, clamps value limits to 1,000 and the collection ceiling, never hydrates
objects, and applies the same read/tenant/sensitive-field rails as `select`.
Stored array/string-list values are grouped as stored; they are not unnested.
`collection.counts({ where })` returns `{ total, filtered }` through two scoped
`COUNT(*)` queries. Local coverage is SQLite/DuckDB; optional scalar PostgreSQL
coverage requires `SMRT_TEST_POSTGRES_URL`.

`executeCollectionReadPlan()` bounds concurrent reads across independent
collections while preserving the normal registry and collection options. The
caller supplies a positive `maxConcurrency`; the executor does not compose SQL,
cache, or alter pool defaults, and drains already-started work before returning
the first error.

`where` operators must remain aligned with `@happyvertical/sql`'s `buildWhere`:
`=`, `>`, `<`, `>=`, `<=`, `!=`, `in`, `not in`, and `like`. Arrays imply `IN`,
and null values render `IS NULL`/`IS NOT NULL`. `contains` and dot-notation JSON
paths are intentionally rejected until the SQL layer supports them.

For subclass-owned bounded SQL, `resolveListReadPredicate()` provides SQL scope
plus `finish(instances)`. Call `finish` exactly once on the final hydrated page
(including empty pages), after raw-query hooks and annotations, outside provider
fallback catches. It invokes normal `afterList` using the original `beforeList`
context and model identity. It does not fetch replacement rows after filtering.
ID-only consumers have no hydrated page and do not call this completion step.

`semanticSearchIdsWithAvailability()` is the protected fallback-aware boundary:
only absent embedding configuration or a failed `provider.embed()` returns
`available: false`. Invalid options, authorization, ranking, query, and caller
override failures propagate regardless of their error class. Public
`semanticSearchIds()` keeps its array/throw contract by throwing the returned
provider error. Consumers must branch on availability, never classify thrown
`EmbeddingUnavailableError` values from an entire search as provider failures.

Semantic ID eligibility binds its complete beforeList/STI/where predicate once
in a CTE per candidate chunk. Only the scalar eligibility mask leaves the
application database. Candidate chunks use the remaining conservative 999-bind
budget (minimum 1); a predicate already larger than that budget retains the
adapter’s existing capacity instead of being rejected by a new API limit.


### B1b reuse check and integration boundary

No production component, model, route, tool or file was added. Before extending
these APIs, the configured smrt-dev-mcp `review-smrt-project` ran on core,
commerce, smrt-svelte and smrt-web, and `build-context` architecture searched
for displayLabelField, display.label, one-hop names, relationship projections
and reference sources. The server offers context/introspection rather than a
separate component-search tool. Read `docs/knowledge/intents/index.md` and used
`rg` by name and purpose in core, commerce, profiles, smrt-ui, smrt-svelte and
chat, plus workspace-wide displayLabel searches. Planner's preview name lookup
is not a bounded, authorized collection query and was not reused.

| Addition in existing module | Existing capability reused / reason for extension |
| --- | --- |
| `DisplayLabelProjection`, `resolveDisplayLabelProjection` in ui-metadata | Extends the owning display-label contract; the existing resolver only accepted own fields |
| `resolveDisplayLabelSource` in collection | Reuses latest-related's target `beforeList`/STI pattern, public projection and ordering validation, primary-key resolution, and qualified relationship resolver |
| SmrtObject serialization / `_setDisplayLabel` | Uses the existing hydration and framework serialization seams; computed labels never enter registered/persisted fields |
| `parseRestListWhere` in query-bounds | Extracts the existing REST bracket decoder for generated SvelteKit list/count queries; MCP architecture and `rg` parser/operator searches across core, smrt-web, smrt-svelte, smrt-ui and chat found no existing server decoder outside REST |
| Test-schema dependency expansion | Extends `getTestDatabase`'s existing physical-FK closure to the declared display read dependency |
| `display-label-projection.test.ts` | Test-only Display* models and fixtures reuse `getTestDatabase`, real SQLite, `GlobalInterceptors`, and generated REST; existing tests covered projections and relationships separately |
| commerce `customer-display-projection.test.ts` | Test-only setup reuses actual Customer, Profile, generated REST/web definitions and existing screens `createRecipeScreenReferences`/`screenRecordLabel`; no duplicate screen adapter |

The reference source and label resolver already accept the generated computed
field, as the commerce canary proves. Current screen field derivation does not
honor web `readonly` metadata and drops fields absent from a persisted-field
policy. Completing read-only forms and policy-independent record titles requires
small changes in smrt-svelte `screens/types.ts` and `screens/fields.ts`, outside
this worker's reference-source/label-file restriction. That UI change remains
pending scope approval; RecipeScreens and cookbook files are untouched.


Regression evidence: the same metadata assertion was executed against the
original `ManifestGenerator` from base `5368f3bada` and this implementation.
Base exited 1 with “display.label must be the name of an own field”; head exited
0 and emitted `displayLabelField: 'displayLabel'`. Temporary proof files were
removed. The executable scanner and SQLite suites retain the regression cases.

### Integration rebase: live exposure and effective STI identities

Projected names compose with the live exposure gate at the existing REST entry
boundary: disabled list/get requests return 404 before collection access, SQL or
conditional ETag evaluation. The collection projection does not change tool
approval policy or saved approval summaries; it is a read representation, while
owner decisions keep using the existing live tool gate and original principal.
No chat/approval implementation was changed.

`display-label-projection.test.ts` tests a retained ETag after enable → disable
and asserts zero SQL; `sveltekit-generator.runtime.test.ts` executes an emitted
projected list route, passes name search/order to its source, and verifies closed
exposure prevents list/count. The scanned same-name fixture also creates through
REST at the effective app STI root (private client discriminators stay ignored) and creates
a provider subtype through the collection API, then projects that related
subtype's name; provider cookbook identity enables the app Customer projection. Existing scoped SQL, sensitive-field and target
beforeList checks still apply. All persistence is in-process SQLite.
