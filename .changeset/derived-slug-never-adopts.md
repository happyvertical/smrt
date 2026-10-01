---
'@happyvertical/smrt-core': minor
---

A name is not an identity: a NEW object whose slug `getSlug()` derived from
`name`, `title` or `label` no longer adopts (and overwrites) an existing row
that happens to share that slug. It keeps its own id and saves under the first
free `<slug>-2` … `<slug>-9` (found with one query), then
`<slug>-<first 8 id characters>`, as a plain INSERT, whoever owns the taken
row (it is never refused as another tenant's). Before, two "New conversation"
chat threads, two people called "John Smith" or two articles titled "Council
meeting" in one tenant collapsed into one row. (Assets no longer derive their
slug from the file name at all: see the smrt-assets change; their default slug
is the asset's id.)

**Behaviour change for idempotent importers.** A plain `create({ name, … })` or
`new X({ name }).save()` repeated for the same name now adds `<slug>-2`,
`<slug>-3`, … instead of updating the first row. Pass `slug` explicitly, use
`conflictColumns` with an external id, or use `getOrUpsert()`.

Explicit natural keys still upsert in place: an explicitly set `slug`,
`conflictColumns` without `slug` (external ids) and persisted objects are
unchanged. `getOrUpsert()` keeps its contract: when its lookup misses (for
example a non-key field such as `color` differs), the create is keyed by the
natural key the data names, a derived slug included, so the row that key names
is updated in place rather than duplicated. An adopted same-owner row keeps
its `id` and `created_at`.

On PostgreSQL a new object with no NULL in its natural key is written with
`INSERT … ON CONFLICT DO NOTHING` first, so concurrent first creates never
collapse into one row or rewrite a primary key: the loser adopts the winner's
row (explicit key) or moves to a free slug (derived slug).
