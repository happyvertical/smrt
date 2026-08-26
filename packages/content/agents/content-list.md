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
  re-applied by the lock effect (equality-guarded, so it settles).
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

A server query always carries a page limit, so supplying `query` seeds the
controller's `pageSize` (from `query.request.defaultPageSize`, default 50).
Local mode keeps the historical unpaginated list.

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

Dropped rather than sent, because sending them would fail the *whole* request:

- `notContains` — the executor refuses to negate a `like`.
- `isNull` / `isNotNull` — there is no null-aware operator, and `ne null` is
  never true in SQL.
- `contains` / `startsWith` / `endsWith` on a datetime column — `like` is
  string-only in the request normalizer.
- an unparseable datetime value — the normalizer requires an RFC 3339 instant.

Server filters compare **exactly**; local mode compares case-insensitively. The
adapter already lowercases `type` / `status` / `state` filter values, which is
what keeps the two agreeing for the toolbar filters.

### Scope is application-supplied and server-derived

A `DataQueryRequest` carries no authority. Tenancy is applied inside
`executeContentQuery` (fail-closed to global rows). Site, organization, or
workspace narrowing is the host's: the framework models neither site nor
organization, so a host calls `executeContentQuery(collection, body, { scope })`
from its own route with conditions derived from the authenticated context —
never from the request body.

### Documented limits

- Offset paging only; the schema declares `supports.cursorPagination: false`.
- `body` is not queryable — it is a document, and the envelope caps a scalar at
  4096 characters. Read it through `GET /api/v1/contents/{id}`.
- `metadata` path filtering is unavailable: JSON columns get no filter operators.
- There is no ETag or version slot in the canonical envelope; `queryFingerprint`
  and `freshness.asOf` serve that role.
- A restored page size is clamped to `CONTENT_LIST_MAX_PAGE_SIZE` (200), which
  matches the schema's `maxPageLimit`, and the clamp is reported.

### URL state and saved views

`urlState` is router-agnostic on purpose: `params` is read **once** at
initialization, and every later change is handed back through `onChange(params,
state)` with foreign parameters preserved, so a SvelteKit host calls
`replaceState`, a hash router rewrites the fragment, and a test passes a plain
`URLSearchParams`. Restoration goes through `applyContentListViewState`, which
merges over current state rather than dispatching `setSearch`/`setFilters` —
those would reset the restored page.

The `type` prop lock still wins after a restore: the lock effect enforces
against live state, so a restored `?type=document` is replaced by the locked
value.

Everything a restore or a translation refused is reported in one dismissible
notice rather than thrown — a stale link or an out-of-date saved view must still
open the list, minus the parts that are no longer meaningful.
