<!-- Module doc for packages/content/AGENTS.md. Linked from the Modules table there. -->

# ContentList: shared adapter, server query, URL state, saved views

`ContentList` reads every row, column, filter, and action through one shared
adapter (`src/svelte/content-list-controller.ts`) over a `DataTableController`,
and can source those rows either from a client array or from the bounded
content query endpoint. This doc covers both modes end to end.

## ContentList migration (#2451)

`ContentList` no longer holds bespoke local state. `src/svelte/content-list-controller.ts`
is the single adapter every presentation reads from, and one shared
`DataTableController` (from `@happyvertical/smrt-ui/data`) owns search, filters,
sorting, page, and selection.

| Before | After |
|--------|-------|
| local `searchTerm`/`selectedType`/`selectedStatus` runes | controller commands `setSearch` / `setFilters` (stable filter ids `type`, `status`) |
| `filteredContents` `$derived` per view | `toContentListRows` → `selectContentListRows` → `paginateContentListRows`, computed once for all three modes |
| bespoke `<table>` markup in compact mode | smrt-ui `DataTable` with the shared columns plus per-column cell snippets |
| no selection | checkbox selection in every mode via `toggleRowSelection` / `setSelectedRows` |
| `getViewHref` called inline three times | `resolveContentHref` / `contentListRowActions` (one eligibility source) |

Props are unchanged and still exported as `ContentListProps`: `apiBaseUrl`,
`contents`, `type` (still locks and hides the type filter), `defaultViewMode`
(still seeds once), `onEdit`, `onDelete`, `onAdd`, `controls`, `getViewHref`.
New optional props: `loading`, `error`, `onRetry`, and `dataSurface`
(`{ registry, descriptor? }`).

Adapter exports (also re-exported from `./svelte`): `createContentListController`,
`buildContentListColumns`, `buildContentListSurfaceDescriptor`,
`toContentListRows`, `selectContentListRows`, `paginateContentListRows`,
`contentListFilters`, `readContentListFilter`, `applyContentListFilter`,
`contentListRowActions`, `resolveContentHref`, `selectableContentListRowIds`,
`resolveSelectedContentListRows`, `resolveSelectedContents`, plus the
`CONTENT_LIST_*` identity constants.

Notes:

- Controller modes are all `manual`: the adapter owns search, filters, sorting,
  and paging in **every** presentation, and the compact table receives
  `data={pageRows}` plus `totalRows={queryRows.length}`. Letting DataTable
  filter locally over already-filtered rows re-ran the transform with subtly
  different semantics (untrimmed search, its own equality rules), so the two
  presentations could disagree. The component clamps the page with
  `controller.clampPage(queryRows.length)`. #2452 replaces the local
  implementation of that transform with a server query behind the same contract.
- A `type` prop lock is enforced against live state, not just against the prop:
  a data-surface `set-filters` or `reset` command that drops the type filter is
  re-applied by the lock effect (equality-guarded, so it settles). The unlocked
  branch clears the filter only on an actual lock-REMOVAL transition — tracked
  with a non-reactive `previousLockedType` — because clearing on every run would
  also discard a type filter restored from a link or a saved view, and clearing
  never would strand the old lock after the prop went away.
- Selection may only address durable rows. All three presentations render a
  disabled, explained checkbox for `identified: false` rows, page select-all
  skips them, and a normalization effect re-dispatches `setSelectedRows` without
  any non-durable id, which covers data-surface commands too.
- Compact mode renders a content-owned `select` column (header + cell snippets)
  instead of passing `selectable` to DataTable. DataTable has no per-row
  selection predicate, so its header select-all addresses the synthetic id of an
  unidentified row; the normalization effect then strips it and the header stays
  indeterminate forever. Because column order is reconciled from the
  controller's known column ids, the structural `select` and `actions` ids are
  part of `CONTENT_LIST_TABLE_COLUMN_IDS` — omit them and selection renders
  behind every data column.
- Only rendered columns are published to a data surface. `description` is a
  hidden, search-only column so search still reaches the deck; the descriptor
  additionally declares the `id` row-key column, which the surface contract
  requires but the table never renders.
- Rows without a durable `id` (or repeating one) still render, keyed by
  position, but are marked `identified: false`;
  `resolveSelectedContentListRows` drops them so a bulk action can never act on
  an unaddressable row. `ContentData` has no expiry or site field, so the
  `site` column is derived from `url`/`source`.
- Column ids are public identifiers and do not always match the model field, so
  the descriptor's `fieldName` comes from an explicit map
  (`publish` → `publish_date`, `updated` → `updatedAt`); the derived `site`
  column advertises no field at all rather than a nonexistent one.
- Filter values are normalized per column (`type` via `normalizeContentType`,
  everything else via `normalizeContentToken`) through
  `normalizeContentListFilterValue`, and a blank value clears the filter — an
  `equals ''` filter would silently exclude every row.
- The card presentations render their own page controls (smrt-ui `Pagination`
  dispatching `setPage`) and their own polite refresh status, because DataTable
  — which owns both in compact mode — is not mounted there. A page size arriving
  from a saved view or a surface command would otherwise strand the operator on
  page one, and a refresh over retained rows would be silent.
- `dataSurface` registers the compact table only. Agent addressability for the
  grid and detailed presentations lands with #2456.
- Compact mode stays mounted for empty and loading results — DataTable renders
  its own `empty` snippet and loading row — because it owns the mounted surface:
  swapping it for the shared empty panel unregisters the surface, and an agent
  whose own search returned nothing then gets `not_found` on the command that
  would undo it. The shared loading/empty panels are the card presentations'
  only; the `error` branch still replaces the list in every mode, since a load
  failure is host-driven rather than surface-driven.

## ContentList server-backed mode (#2452)

`ContentList` gained three optional, independent opt-ins. Omit all three and the
component behaves exactly as it did after #2451 — `ContentWorkspaceRoute` passes
`contents` and nothing else and is unchanged.

| Prop | Type | Effect |
|---|---|---|
| `query` | `ContentListQuerySource` | Rows come from `POST /api/v1/contents/query`; `contents` is ignored |
| `urlState` | `ContentListUrlStateBinding` | Restore from, and publish to, a query string |
| `savedViews` | `ContentListSavedViewStore` | Save / apply / delete named views |

### The query seam

`query.bind()` is called **once**, during component initialization, and returns
a `ContentListQueryBinding`. `remoteQuery(collection, transport)` from
`@happyvertical/smrt-svelte/web` satisfies that interface structurally, so its
`$effect` teardown is registered in `ContentList`'s own scope and disposed with
it:

```svelte
const transport = createContentListQueryTransport({ apiBaseUrl: '/api/v1' });
<ContentList query={{ bind: () => remoteQuery(collection, transport) }} … />
```

The binding type is declared **structurally rather than imported**: pulling
`@happyvertical/smrt-svelte` (and through it `@happyvertical/smrt-web` and
`@tanstack/db`) into `@happyvertical/smrt-content/svelte` would put the browser
data runtime in a barrel that public content pages import, defeating the
code-split boundary that runtime's own AGENTS.md ratifies. smrt-web mirrors
`smrt-types` for the same reason.

### Three id namespaces

A list value crosses three vocabularies that do not agree, and the bridge is
explicit in both directions:

| Namespace | Example | Owner |
|---|---|---|
| adapter column id | `updated` | `content-list-controller.ts` |
| `ContentData` field | `updatedAt` | `mock-smrt-client.ts` |
| server data-query field id | `updated_at` | the registered `Content` model |

`CONTENT_LIST_QUERY_FIELDS` maps column → server field
(`publish` → `publish_date`, `updated` → `updated_at`), and
`ROW_FIELD_TO_CONTENT_KEY` maps result row → `ContentData`
(`updated_at` → `updatedAt`, `created_at` → `createdAt`).
`content-list-query.test.ts` asserts the first map against the *real*
`buildContentQuerySchema()` — field ids, declared types, and declared filter
operators — so a model rename breaks a test rather than a production query.

`site` has **no** server field: it is derived in the browser from
`url`/`source`. A filter or sort on it is dropped from the request and reported.

### The local transform is the local-mode path only

In server mode the returned rows *are* the answer — the server already applied
search, filters, sort, and page — so `selectContentListRows` /
`paginateContentListRows` must not run over them. Running them again re-filters
with different semantics (untrimmed search, case-insensitive comparison, a
`site` predicate the server never saw) and can hide rows the server returned.
`totalRows` therefore comes from `result.total`, not from the page length, and
`clampPage` waits for the first authoritative total instead of clamping to zero.

Selection normalization also changes shape in server mode: `rows` is only the
current page, so membership cannot be the durability test (it would clear the
selection on every page change). Only the adapter's synthetic ids are stripped.

### One page-size ceiling, one page size

`maxPageSize` is resolved ONCE, by `resolveContentListMaxPageSize`, as the
minimum of every configured limit and the schema's `maxPageLimit` — every
candidate narrows, so a host that sets `query.request.maxPageSize` as a server
row budget does not lose it to a looser `urlState.options.maxPageSize`. That one
number is passed to the controller seed, the URL sanitizer, the saved-view
sanitizer and the translator, which is what makes the size the UI pages by and
the size the server applies the same number *by construction*.

Two page sizes are unusable in server mode, and BOTH are coerced against live
state (a saved view, a link, and a data-surface `set-page-size` all arrive after
mount) and reported:

| Live page size | Coerced to | Why |
|---|---|---|
| `null` | the seed | the endpoint always applies a limit |
| `> maxPageSize` | `maxPageSize` | the translator clamps the request, so leaving the controller higher makes `totalPages` compute 1 and hide the page controls |

The seed itself is clamped to the ceiling too: a `defaultPageSize` above it
would otherwise seed a page size the request silently reduces.

`pageSize: null` means "show everything", and the query endpoint has no way to
express that. Left alone, a null page size renders one page of `limit` rows with
no page controls and no way to reach the rest, so in server mode it is
**coerced and reported**:

- supplying `query` seeds the controller's `pageSize` from
  `query.request.defaultPageSize` (default 50), clamped to the ceiling;
- that same number is handed to the URL layer as its `defaultPageSize`, so a
  link that omits `size` restores the seed instead of overwriting it with the
  local `null`, and a link this list writes omits `size` while at the default;
- a null arriving later — `?size=all`, a saved view, a data-surface
  `set-page-size` — is coerced by an effect against live state, and the
  translator reports the same coercion for a direct caller.

Both report a `pageSize` / `unpaginated-unsupported` drop in the notice. Local
mode keeps the historical unpaginated list unchanged; the coercion is
server-mode-only.

### Search, and what the protocol cannot express

The protocol has `filter` only — no search primitive. `state.search` becomes an
`any` of `like` predicates over the adapter's searchable columns (`title`,
`description`, `author`), with the wildcards added client-side and the
operator's own `%`/`_` escaped with a backslash.

**Known dialect gap:** PostgreSQL and DuckDB honour a backslash as the default
`LIKE` escape; SQLite has none and the collection query builder emits no
`ESCAPE` clause, so on SQLite an escaped `%` matches the two literal characters.
That fails closed (empty result) rather than open (every row); a portable fix
needs an `ESCAPE` clause at the collection/SQL boundary.

`isNull` / `isNotNull` map to a **null-valued `eq` / `ne`**. That is null-aware
end to end and is not a comparison against NULL: the protocol scalar type admits
`null`, the request normalizer rejects a null value only for
`gt`/`gte`/`lt`/`lte`/`like`, and `buildWhere` lowers `{ field: null }` to
`IS NULL` and `{ 'field !=': null }` to `IS NOT NULL`.

Dropped rather than sent, because sending them would fail the *whole* request:

- `notContains` — the executor refuses to negate a `like`. The only operator
  with no server expression.
- `contains` / `startsWith` / `endsWith` on a datetime column — `like` is
  string-only in the request normalizer.
- an unparseable datetime value — the normalizer requires an RFC 3339 instant.

The translator also enforces the normalizer's **input caps**, because exceeding
one 400s the entire list rather than degrading it. Each is capped and reported:
at most 100 `in`/`notIn` values, at most 50 filter nodes (counting every
`all`/`any` container, so search costs 4 and the outer `all` 1), at most 50
projection fields — each of which must also be a declared projectable field id
of 1-256 characters, or it is dropped rather than 400ing the list — a request id
of at most 128 characters, at most 4096 characters per filter value, and 100 000
bytes for the whole serialized request (100 values of 4096 characters is inside
every per-value cap and still five times that limit, so the newest filter
branches are shed until it fits).

**Measure what the server measures.** `boundRequestSize` weighs the NORMALIZED
request, not the body as sent, and the normalizer injects `schema.defaultSort`
when `sort` is absent — 84 bytes the client had not counted, so a request of
99 917-100 000 bytes passed the client check and 400ed at the server. The
translator therefore always emits `sort`, falling back to
`CONTENT_LIST_QUERY_DEFAULT_SORT` (the schema default) rather than omitting the
key. The invariant to preserve: the client's byte count is never smaller than
core's.

**Measure in the server's unit.** `dataQueryScalar` tests `value.length`, which
counts UTF-16 code units, so an astral character costs TWO. The bounders iterate
by code point — never splitting a surrogate pair — but charge `character.length`
per code point plus one for an escape. Charging one per code point made a search
of 4093 ASCII characters plus one emoji measure 4094 client-side and 4097
server-side: a hard 400 and a whole-list error panel.

And mirror the normalizer's **validity rules**, not only its numeric caps. A
datetime is checked against the server's exact RFC 3339 pattern rather than
merely round-tripping through `Date`: a year outside the four-digit range
serializes as `+275760-09-13T00:00:00.000Z` and is refused.

### Filter case: tokens are folded, free text is not

`normalizeContentListFilterValue` folds case for the **token** columns only —
`type`, `status`, `state`, whose domain is a fixed lowercase vocabulary the
model writes. Every other column holds text a person typed, and its value
becomes a server-side `eq` or `like` compared against the STORED text: folding
`NASA` to `%nasa%` would miss `NASA Update` on PostgreSQL or DuckDB. The helper
dates from #2451, when every comparison was local and folding everything was
harmless; server mode invalidated that assumption.

Preserving case is safe locally because the local evaluator compares through
`textValue()`, which lower-cases BOTH sides at compare time — a case-preserving
stored value still matches case-insensitively there. The `type`-lock predicate
(`isContentListFilterExactly`) goes through the same helper, so the lock still
settles rather than re-dispatching.

**Free-text server matching is therefore dialect-dependent, and the protocol
cannot make it uniform.** There is no `ilike` in the operator vocabulary, so:

| Backend | `like` / `eq` on free text |
|---|---|
| PostgreSQL, DuckDB | case-SENSITIVE |
| SQLite | case-insensitive for ASCII |

Local mode is case-insensitive everywhere. Do not describe free-text filtering
as uniform; a portable fix needs a case-insensitive operator at the collection
boundary.

### NULL semantics are aligned

The same shared link must return the same rows whether the host passed a `query`
or not, so every null-sensitive operator now agrees across the two modes. Two
different alignments were needed, in opposite directions, because the *meaning*
differs per operator:

| Operator | Server lowering | Alignment |
|---|---|---|
| `eq`, `in`, `like` (`contains`/`startsWith`/`endsWith`) | plain predicate | already agreed — both exclude an absent row |
| `in` with a `null` listed | `IS NULL OR IN (…)` | already aligned |
| `ne` (value ≠ null) | `IS NULL OR <> v` | server gained the union: "not v" includes rows with no value, as the local evaluator has always said |
| `notIn` (no `null` listed) | `IS NULL OR (AND of <> v)` | same |
| `notIn` WITH a `null` listed | `(AND of <> v) AND IS NOT NULL` | **no union**: a listed `null` says absent rows are excluded too |
| `ne null` (`isNotNull`) | `IS NOT NULL` | untouched — a union would match every row |
| `gt`, `gte`, `lt`, `lte` | plain predicate | the LOCAL evaluator gained null-awareness |
| `isNull` / `isNotNull` | `IS NULL` / `IS NOT NULL` | the LOCAL evaluator gained null-awareness |

**A listed `null` inverts the rule, and getting that wrong is a data leak of the
worst kind — a filter returning exactly the rows it was asked to exclude.**
`notIn ['Ada', null]` means "not Ada, and not blank", so it must NOT gain the
`IS NULL` union. It is reachable from the wire (`normalizeFilter` accepts a null
list entry) and through `not(in ['Ada', null])`. Without the distinction,
`in [x, null]` and its own negation both match the absent row: a predicate
overlapping its negation. The executor tests assert every list shape
(no null / with null / null-only / inverted) partitions the rows with no overlap
and no gap.

**The ordered comparisons were aligned on the LOCAL side, not the server's.**
`ContentListRow` flattens every field to display text, so an absent value read
as `''` — which sorts below everything, made `publish_date lt X` match every
never-published row, and made `isNull` match nothing at all. The original
`ContentData` still distinguishes absent from empty, so
`isAbsentContentValue()` consults it and the null-sensitive operators exclude an
absent value exactly as SQL's three-valued logic does. This is the direction the
data means: "no publish date" is not "published before X". It also aligns the
blank-comparand case (`?author.lt=`, `?author.gte=`), where the flattened `''`
used to compare equal and the two modes disagreed, and it leaves a column that
genuinely stores `''` (`title`, `name`) comparing as present in both modes.

The `ne`/`notIn` union costs a second DNF branch each, and an `all` multiplies,
so the translator also mirrors `MAX_CONTENT_QUERY_OR_BRANCHES` (128) and drops
filters before the executor would refuse the whole request. The mirror is exact
rather than conservative — including the listed-`null` case, which costs one
branch rather than two — and it handles De Morgan under `not`, so a future
negating emitter cannot silently under-count.

### Scope is application-supplied and server-derived

A `DataQueryRequest` carries no authority. Tenancy is applied inside
`executeContentQuery` (fail-closed to global rows). Site, organization, or
workspace narrowing is the host's: the framework models neither site nor
organization, so a host calls `executeContentQuery(collection, body, { scope })`
from its own route with conditions derived from the authenticated context —
never from the request body.

### Mirrored constants are self-enforcing

Every number this package copies from the schema or from
`@happyvertical/smrt-core` is bound to its source by a test, because a
hand-copied limit that drifts is the defect this issue kept producing: lowering
the server's page limit while the client still seeds and pages by the old one
strands rows with the whole suite green.

Where core exports the constant the assertion is direct; where it does not, the
assertion pins core's observable BEHAVIOUR — the largest value it accepts and
the smallest it refuses — rather than being skipped. Add a cross-assertion
alongside any new mirrored number. The field map, projectable fields, operator
vocabulary and search fields are asserted against the real
`buildContentQuerySchema()` for the same reason.

### Documented limits

- Offset paging only; the schema declares `supports.cursorPagination: false`.
- `body` is not queryable — it is a document, and the envelope caps a scalar at
  4096 characters. Read it through `GET /api/v1/contents/{id}`.
- `metadata` path filtering is unavailable: JSON columns get no filter operators.
- There is no ETag or version slot in the canonical envelope; `queryFingerprint`
  and `freshness.asOf` serve that role.
- A restored page size is clamped to `maxPageSize` (default
  `CONTENT_LIST_MAX_PAGE_SIZE`, 200, matching the schema's `maxPageLimit`), and
  the clamp is reported. The ceiling is resolved once and applied to **both**
  restore paths — a saved view is not a way around a limit a host set for links.
- The server bounds its own answer: it shortens over-long values and drops
  trailing rows to fit `maxResultBytes`, flagging `truncated` with a warning.
  That matters to a paging client, because the next page is computed from
  `page * limit`, so dropped rows are skipped on the following page too.
  `ContentList` reads those flags — from the binding when it exposes them, and
  otherwise off the envelope its own `execute` resolved — and renders them in
  the same notice as the drops.
- A `json` field (`metadata`, `tags`) is validated as a document, not a scalar,
  and `canonicalJson` rejects the WHOLE result when a nested value breaks any of
  its rules. `executeContentQuery` therefore bounds a JSON document itself —
  65536-character strings, 1000-item containers, depth 16, finite numbers, no
  cycles, plain values only — flagging `truncated` rather than failing the page.
  It also drops the keys `plainObject` forbids (`__proto__`, `constructor`,
  `prototype`) and builds with a null prototype, because that is the *reachable*
  rule: `metadata` is the documented extension point, it is writable through the
  REST API and through `mirror()` ingestion, and `JSON.parse` of the stored
  column creates an own `__proto__` property — so one row could otherwise make
  every query projecting metadata return 400 for the whole page, permanently.
- Facet values are held to the SAME shared byte budget as rows. Two text facets
  of 200 distinct 4096-character values are inside every per-value cap and still
  several times the 1 MB result limit; values are dropped and the facet and the
  result are flagged rather than the response being refused.
- A capped offset moves the caller's page marker AND says so. `?page=9000&size=200`
  caps the request offset at 1 000 000; the translation returns the
  `effectivePage` the request actually reads, and the redirect is reported in
  the notice ("page 9000 cannot be loaded — the list stops at page 5001"). That
  drop is held apart from the rest, because the corrective dispatch re-enters
  the query effect in the same flush and the second translation caps nothing —
  storing it with the others would erase it before it was ever rendered. It
  stands until the operator moves off the page they landed on.
- The pagers never advertise a page the endpoint cannot fetch. `totalPages` — and
  the `totalRows` handed to DataTable, which derives its own page count and
  takes no ceiling — are capped at `floor(MAX_OFFSET / pageSize) + 1`.
  `clampPage` deliberately keeps using the TRUE total, so a crafted `?page=`
  still reaches the query effect and gets the notice instead of being silently
  clamped first.
- DataTable is told `totalRows: undefined` until the first authoritative total
  arrives. It clamps the controller's page against `totalRows`, so the
  pre-response zero would reset a page restored from a link the moment the
  compact table mounts.
- A retry replaces the rendered rows, so it also replaces the completeness
  flags. `retry()`'s envelope is read through the same path as `execute()`'s;
  discarding it left a "rows are missing" notice standing over a complete page.

### URL state and saved views

`urlState` is router-agnostic on purpose: `params` is read **once** at
initialization, and every later change is handed back through `onChange(params,
state)` with foreign parameters preserved, so a SvelteKit host calls
`replaceState`, a hash router rewrites the fragment, and a test passes a plain
`URLSearchParams`. Restoration goes through `applyContentListViewState`, which
merges over current state rather than dispatching `setSearch`/`setFilters` —
those would reset the restored page.

**INVARIANT: no exported path may apply unvalidated state to a controller.**
`applyContentListViewState` sanitizes its patch, because it is the one
application point the package publishes and it is routinely composed with
untrusted values. That is what makes
`applyContentListViewState(controller, store.snapshot.state)` safe even though
the store's read path deliberately returns a raw
{@link RawContentListViewSnapshot} — keeping the raw payload is what lets
`restoreContentListSavedView` still report a stale view's drops. Sanitization is
idempotent, so ContentList's own already-validated patches are unaffected. Only
the patch is sanitized, never the merged result: the sanitizer never emits
selection, so sanitizing the merge would clear the operator's selection.

Two URL-serialization rules the round trip depends on:

- an `in`/`notIn` entry containing the list separator is escaped with a
  backslash on write and unescaped on read, so `author in ["Smith, John"]`
  restores as one value rather than two — a silently *different* query;
- a parameter is owned (and therefore removable while rewriting) by its **base
  name** only. A host's `facet.contains=` carries a known operator suffix but
  names no ContentList column, so it survives. That is narrower than the
  recognizer in `readContentListViewStateFromSearchParams`, which still reports
  an operator-suffixed unknown column so a crafted `evil.contains=` stays
  visible: reporting a refusal and deleting a parameter are different acts.

The `type` prop lock still wins after a restore: the lock effect enforces
against live state, so a restored `?type=document` is replaced by the locked
value. The lock is folded into the restored patch rather than re-applied
afterwards, because the restore replaces the whole filter set and the lock's
`setFilters` resets paging — a locked list opening `?page=3` would otherwise
land on page 1, silently.

### A restored value the toolbar cannot show

The two toolbar selects publish a display vocabulary
(`CONTENT_LIST_TYPE_OPTIONS`, `CONTENT_LIST_STATUS_OPTIONS`), but the sanitizer
accepts any non-blank token, so a link can restore a filter the select has no
option for — `?status=review` (a real `Content.status`), or a typo like
`?type=artcile`. The select would show nothing while a live predicate emptied
the list.

Both selects handle it identically, and do two things rather than one:

1. the value is rendered as an extra option, so the toolbar tells the truth
   about what is constraining the list and the operator can clear it;
2. it is reported in the notice, so an empty result always has an explanation.

A select can only offer a single `equals` value, though, and a link can restore
much more than that. **INVARIANT: the select's displayed state either matches
the live predicate exactly, or the operator is told it does not.** Three states,
all reachable from a shared link:

| Live filter | Select shows | Reported |
|---|---|---|
| `equals` with a listed value | the value | no |
| `equals` with an unlisted value (`?status=embargoed`, a typo) | the value, as an extra option | yes |
| anything else — a list value (`?status.in=draft,review`), a valueless operator (`?status.isNull=1`), an inverted one (`?status.notEquals=draft`), or two filters on one column | a DISABLED summary of the real predicate | yes |

The third row is the one that matters: a value-only read reports nothing for a
list value and reports `draft` for `notEquals draft` — the exact inverse of the
query. `readContentListSelectFilter` is operator-aware and is the seam that
keeps the control from misstating the query; `readContentListFilter` stays
value-only and must not drive a control. Choosing any real option replaces every
filter on that column, so the operator is never stuck.

`review` is now offered outright. `deleted` is deliberately not: that is the
trash lifecycle (#2454), and offering it here would imply a restore/purge
affordance this list does not have. `Content.type` is freeform, so its option
list is a display vocabulary rather than the model's domain.

Everything a restore or a translation refused is reported in one dismissible
notice rather than thrown — a stale link or an out-of-date saved view must still
open the list, minus the parts that are no longer meaningful.
