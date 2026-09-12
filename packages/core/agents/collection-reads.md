<!-- Module doc for packages/core/AGENTS.md. Linked from the Modules table there. -->

# Collection reads

This module covers bounded collection reads beyond the basic query contract in
`packages/core/AGENTS.md`.

## Projections and related rows

`list({ select })` uses SMRT field names, maps them to database columns, and
returns plain rows without hydrating objects. It composes with `where`,
`orderBy`, `limit`, and `offset`, runs normal `beforeList`/tenant interceptors,
and is limited to column-backed fields; it cannot combine with `include`.

## Bounded STI discriminator scopes

An STI child collection remains scoped to its own qualified `_meta_type` by
default. A migration that must read registered sibling types may opt into an
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
Point reads through `get()` remain child-only; use a bounded
`list({ where, limit: 1, stiScope })` migration read when sibling hydration is
required.

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
