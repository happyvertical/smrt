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
text field. Display projection is lazy: `list({ displayLabel: true })` and
`get(filter, { displayLabel: true })` include it on hydrated JSON/public DTOs;
`list({ select: ['id', 'displayLabel'] })` returns plain selected values.
Filtering on `displayLabel`/`display_label` or sorting by it also requests the
projection. `count()` resolves it only when its effective filter needs it.
Filtering, ordering and pagination happen in SQL, with one data SELECT per list
page, independent of row count. Target lookup uses its existing primary-key index.

Plain list/get/count and persisted-field select calls retain their existing
contract: they do not construct, verify, query or join the display target. They
work when only the source schema is migrated. Generated/runtime REST list/get
routes explicitly request the projection for models whose web definitions
publish it, so record headings and reference sources retain human names.

The join resolves the effective qualified target (including same-name app
subclasses), runs the target collection's `beforeList` authorization/tenant
scope and STI branch predicate, and never hydrates target records. Like other
plain projections, target `afterList` hooks do not run; row authorization must
be expressed in `beforeList`. Source/target tenant owners must match exactly,
including global-to-global links; a global source cannot reveal a tenant-owned
name. Missing, invisible, cross-owner, null or blank targets return the declared
fallback. A genuinely unmigrated target table also returns the declared fallback
through a constant SQL projection, preserving filter/sort/count semantics without
creating schema. Only the target verifier's typed `DB_SCHEMA_MISSING` is handled;
authorization, connection, malformed-schema and other failures propagate. Absence
is not cached, so a later ordinary migration makes names readable immediately.
There is no cross-tenant option on the projection. Explicit reviewed
cross-tenant workflows continue to use `loadRelated('profileId', { allowCrossTenant: true })`.

The label is a snapshot of the read, never a writeable model field. Saving a
hydrated object excludes it from persistence, and REST strips label input.
Fresh, unqueried instances do not have a projected label; reload through the
collection after a write. Requested display projections bypass the row cache and
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

The reference source and label resolver consume the generated computed field.
Screen derivation honors readonly metadata and cookbook policies; field-policy
enumeration for virtual labels is owned by smrt-fields.


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


### Collection compatibility regressions (integration pass)

`86d148894b` made the collection field cache generation-sensitive. On refresh,
its synchronous registry fallback omitted the injected system fields returned by
`getAllFields()`, rejecting previously valid `select: ['id']`. Refresh now reuses
`prependSmrtSystemFields()` and retains generation invalidation for app edits.
The fallback remains a pure read, including on immutable collection views used
by semantic-ID adapters; it never writes into a caller-supplied cache.
`2b3e262839` made every read resolve the linked display source; Customer's
`607b20685c` declaration exposed that dependency to ads and other consumers.
Lazy opt-in above restores plain programmatic reads without removing names from
REST/web reads. Existing Content/ads expectations remain unchanged; projection
fixtures explicitly opt in where they assert a computed name.

| Invariant / trigger | Positive case | Failure control | Actor / executor / contract | Level and validation |
| --- | --- | --- | --- | --- |
| Registry generation changes after collection creation | Existing id/slug/context selections still work | Custom-primary-key synthetic id remains refused; sensitive/permission tests retained | Existing caller, same DB handle; SQLite memory/file, native DuckDB and JSON adapter | core collection-select suite; root turbo test/typecheck |
| Optional target is not migrated | Plain list/get/count and persisted select read only the source | Spies forbid target verification or join | Existing caller, in-process SQLite, collection compatibility | core display-label-projection suite; unchanged ads consumer test |
| Label is explicitly requested | Hydrated flag, plain select, filter, sort and count use fallback for missing table; later migration recovers | Target policy and storage failures propagate | Tenant A/B/global controls retained; same SQLite executor, no projection DDL/writes | core display-label-projection suite; generated route and commerce canaries |
| Generated web read | REST and emitted list/get request displayLabel; fresh linked names stay visible | Live gate still returns 404 before SQL; writable input excluded | Authenticated REST caller and public fixture / existing collection executor | core generated route suites; root turbo test |

Regression evidence: the new core cases failed on integration base `e6617a1e2e`
with the same invalid-id and missing-target-table errors. The identity-only fix
passes all 31 collection-select cases, including models with no declared fields. Caller audit found Customer is the sole
production model declaring a linked label; all Customer collection helpers and
consumers retain plain reads unless they request the name. Repository-wide tests
exercise the remaining callers. MCP review/context and name/purpose searches in
core, commerce, profiles, smrt-svelte, smrt-ui and chat found the existing system
field and table-verifier APIs; no new production helper or file was added.
