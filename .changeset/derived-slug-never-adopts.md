---
'@happyvertical/smrt-core': minor
---

A name is not an identity: a NEW object whose slug `getSlug()` derived from
`name`, `title` or `label` no longer adopts (and overwrites) an existing row
that happens to share that slug. It keeps its own id and saves under the first
free `<slug>-2` … `<slug>-9`, then `<slug>-<first 8 id characters>`, as a
plain INSERT (a concurrent claim of the same slug raises a unique violation
instead of overwriting). Before, two pictures named `photo.jpg`, two
"New conversation" chat threads, two people called "John Smith" or two
articles titled "Council meeting" in one tenant collapsed into one row.

Explicit natural keys still upsert in place: an explicitly set `slug`,
`conflictColumns` without `slug` (external ids), `getOrUpsert()`, and
persisted objects are unchanged. Callers that relied on a name-derived slug to
deduplicate repeated creates must now pass `slug` explicitly (or look the row
up first). An adopted same-owner row also keeps its `created_at`.
