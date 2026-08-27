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
  `data={pageRows}` and no `totalRows` at all (see "ContentList owns paging in
  EVERY presentation" below for why that prop is withheld rather than computed).
  Letting DataTable filter locally over already-filtered rows re-ran the
  transform with subtly different semantics (untrimmed search, its own equality
  rules), so the two presentations could disagree. The component clamps the page
  with `controller.clampPage(queryRows.length)`. #2452 replaces the local
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
`totalRows` therefore comes from `result.total`, not from the page length.

**Clamping moves the operator, so it acts only on a count that is exactly
right.** Two findings in a row were "the clamp acted on a number that wasn't the
total", so the rule is stated as a set rather than patched case by case:

| Input | Clamp against it? |
|---|---|
| local mode row count | yes — the supplied array IS the whole result set |
| server total, `exact` | yes |
| server total, `estimated` | **no** — an approximation can hide a page that really exists |
| server total, `unavailable` | **no** — the count is unknown; `rows.length` is the page, not the total |
| no response yet for this query | **no** — a page restored from a link survives until its own count arrives |
| a settled response for a DIFFERENT query | **no** — the binding holds the previous total while a new request is in flight |
| a page-size change | n/a — `setPageSize` resets the page itself |

**ContentList owns paging in EVERY presentation, compact included, and
deliberately never passes `totalRows` to DataTable.** DataTable runs its own
`clampPage(totalRows)` effect against the SAME controller, with no authority
rule and no notion of which query a total belongs to — so for two rounds the
clamp fixes above were live in the card modes and bypassed in compact, where an
`estimated` total clamped a real page away and a stale total reset a restored
one.

One prop cannot serve both jobs: `totalRows` drives that clamp AND DataTable's
pager, so any total authoritative enough to clamp against is also the only total
the pager can show. Passing an authoritative-only total silences the clamp but
leaves compact with no pager on an `estimated` total while the card modes still
show one, and then the two modes disagree about which pages exist — a worse bug
than the one being fixed. So ContentList keeps one clamp (its own effect, with
the authority rule) and one pager (its own `<Pagination>`, driven by
`pageableRowCount`, which accepts an estimate because SHOWING a page and MOVING
the operator are different questions). The same reasoning already made the
selection column content-owned in compact mode.

**Invariant: the presentations must never disagree about which pages exist or
which rows are reachable.** Anything about which page is requested, which pages
are offered, or which rows come back belongs in `describePaging` in the test
suite, which runs the suite in both `grid` and `compact`. `defaultViewMode`
defaults to `grid`, so a plain `renderList` test proves only the arm where
DataTable is not mounted.

`estimated` is a deliberate choice, not an oversight. Clamping on an estimate
strands rows the operator cannot then reach; not clamping can offer a page that
comes back empty, which is visible and self-correcting. Hiding reachable rows is
the worse failure — the same reasoning as "truncation only when it narrows".
Showing a pager is a different question, so `pageableRowCount` still accepts an
estimate through `contentListQueryTotalValue`; only
`contentListQueryExactTotal` feeds the clamp.

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

**Second known dialect gap — where an absent value sorts.** A sort term is
`<field> <ASC|DESC>` and nothing more: `buildOrderBySql` splits the term on
whitespace and discards everything after the direction, and `DataQuerySort`
carries only a field and a direction, so `NULLS FIRST`/`NULLS LAST` cannot be
expressed from this package at all. The placement is therefore whatever the
dialect defaults to — PostgreSQL and DuckDB put NULLs LAST ascending, SQLite
puts them FIRST — which changes **which rows land on page one**.

The local comparator is aligned to ONE documented choice: **absent sorts last
ascending and first descending**, matching the SQL standard, the PostgreSQL and
DuckDB defaults, and therefore the production dialects. A SQLite-backed
deployment will disagree with local mode on where absent values fall. That
divergence is dialect-level and not fixable here; fixing it needs a nulls
placement in the sort term at the `@happyvertical/sql` / `SmrtCollection`
boundary, and a slot for it in `DataQuerySort`. A test pins SQLite's observed
ordering so this note cannot rot.

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

**Validate the input, never the value derived from it.** `new Date()` rolls an
impossible calendar date forward — `2026-02-31` becomes `2026-03-03` — so
checking the *produced* instant against the RFC 3339 pattern reports nothing and
the query silently targets a day the link never named. The translator re-derives
the year/month/day and compares, exactly as `normalizedInstant` does server-side,
and drops the filter with a report. A date-only value (`2026-02-01`) is still
accepted and widened to midnight UTC; only impossible days are refused.

**Truncation is only permissible when it NARROWS.** Every cap above degrades a
request rather than failing it, but degrading is only honest when the answer
stays a subset of the question:

Direction is a property of the OPERATOR, not of the site — the same cap narrows
an `in` and widens a `notIn`, and the same truncation widens a `contains` and
does neither to an `eq`. So the classification is made per operator, and where a
change is neither narrowing nor widening the filter is not sent at all:

| Bound hit | Effect on the result | What happens |
|---|---|---|
| `in` list past 100 values | narrows — a disjunct is removed | capped, reported as `out-of-range` |
| `notIn` list past 100 values, or carrying an entry that cannot be sent faithfully | **widens** — an exclusion is removed | the whole filter is left out, reported as `filter-widened` |
| filter-node, OR-branch, or request-byte budget | **widens** — a conjunct is shed | reported as `filter-widened` |
| a shortened `contains` or `startsWith` pattern, or a shortened search term | **widens** — a shorter pattern matches a superset | sent, reported as `filter-widened` |
| a shortened `endsWith` pattern | **widens**, but only because the TRAILING characters are the ones kept | sent, reported as `filter-widened` |
| a shortened scalar comparand (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`) | **neither** — `gt`/`gte` would widen, `lt`/`lte` would NARROW and hide rows, `eq`/`ne` would name a third row entirely | the filter is left out, reported as `filter-widened` |
| page size, offset, projection count | does not add rows | reported as `out-of-range` |

**Every path lands in one of FOUR states, and every one of them reports.** The
partition is four-way, not three — an `in` list cut to its first hundred values
is a genuine SUBSET, which is allowed and is not a widening:

| State | Example | Reported as |
|---|---|---|
| applied exactly | anything within every bound | nothing to report |
| applied as a true SUPERSET | a shortened `like` pattern | `filter-widened` |
| applied as a true SUBSET | an `in` list past 100 values, or one carrying an entry that could not be used | `out-of-range` / `unsupported-value` |
| not applied at all | a `notIn` that cannot be carried, a shed conjunct, a comparand too long to send | `filter-widened` |

The fourth column is the point: a state without a report is a fifth state, and
it is the one that hides. An unusable entry in an `in` list used to be exactly
that — dropped silently, so the toolbar stated a three-value filter while the
query asked for one and the rows the operator listed vanished without a word.
Any new bound must land in one of the four rows above *and* report.

**Never emit a value the caller did not name.** The list path already refused to
send a shortened entry; the scalar path used to send one and merely relabel the
report, which was affirmatively wrong for half the operators — telling an
operator the list "may include rows it would have excluded" while `lt` was
quietly hiding rows. A comparand that cannot be sent whole is now not sent at
all, which is uniformly a widening and is honestly reported as one.

**Which end of a pattern survives decides whether it widens.**
`boundLikeSource` keeps the LEADING code points for `contains` (`%abc%`) and
`startsWith` (`abc%`) — anything containing or starting with `abcdef` also
contains or starts with `abc`. A suffix pattern (`%abc`) is the mirror image, so
it keeps the TRAILING ones: truncating `%…END` from the front would name a
different ending, dropping the row the operator asked for while picking up
unrelated ones. That is neither a superset nor a subset, and no honest label
exists for it.

A widening `notIn` is never PARTIALLY applied. The cap keeps arrival order, so a
literal `null` past the hundredth entry is the entry shed — and the executor
then takes its "no null listed" arm and unions `IS NULL` back in, returning
every absent-valued row the caller listed `null` to exclude. Dropping the filter
whole is wider still, but it is *honest*: the operator is told the filter is not
being applied instead of being told it was "clamped", which would imply it still
works.

That distinction is the whole point of the `filter-widened` reason. An operator
who is told a list was clamped reasonably assumes the answer is a subset of what
they asked for. Telling them that when the truth is "this now returns rows you
excluded" is worse than telling them nothing.

**Measure in the server's unit.** `dataQueryScalar` tests `value.length`, which
counts UTF-16 code units, so an astral character costs TWO. The bounders iterate
by code point — never splitting a surrogate pair — but charge `character.length`
per code point plus one for an escape. Charging one per code point made a search
of 4093 ASCII characters plus one emoji measure 4094 client-side and 4097
server-side: a hard 400 and a whole-list error panel.

And mirror the normalizer's **validity rules**, not only its numeric caps. A
datetime input is held to three separate checks before it is parsed, because
`Date` will happily accept and silently reinterpret what fails each one:

| Check | Refuses | Why |
|---|---|---|
| calendar round-trip | `2026-02-31` | `Date` rolls it to March 3, so the query targets a day the link never named |
| an offset on a time-bearing value | `2026-02-01T00:00` | no offset means `Date` reads it as LOCAL time, so the identical link submits a different instant per viewer — nine hours apart between London and Tokyo |
| the `T` separator | `2026-02-01 10:00:00Z` | a space leaves the ISO grammar, so `Date` falls through to its implementation-defined legacy parser: the same hazard moved from timezone to engine |
| four-digit year | `+275760-09-13` | serializes to an expanded-year form the server refuses outright |

The rule is "a time must carry an offset", not "a time must state its seconds":
`2026-02-01T12:30Z` and `2026-02-01T12:30+09:00` each name one instant for every
reader and are accepted. A bare calendar day (`2026-02-01`) is accepted too —
`Date` reads it as UTC midnight everywhere. Lower-case `t`/`z` is fine: RFC 3339
§5.6 permits it, and the value is canonicalized through `toISOString()` before
it is sent, so the server only ever sees the strict upper-case form it insists
on.

**Canonicalize before parsing, too.** RFC 3339 §5.6 permits a lower-case
`t`/`z`, but ECMA-262's Date Time String Format specifies the upper-case forms,
so `new Date('2026-02-01t12:30z')` runs on engine-specific heuristics rather
than the spec — the same objection that rules out the space separator. V8 reads
it as UTC, which is luck rather than a guarantee, so the value is upper-cased
before it reaches `Date`. `toUpperCase()` is locale-independent and this grammar
has no other letters, so the canonical form means exactly what the input did.

**Validate and parse the SAME string.** Checking `text.trim()` and then parsing
`text` let `"2026-02-01 "` through, and V8's ISO parser rejects the whitespace
and falls back to the legacy parser — which reads a bare date as LOCAL midnight,
reintroducing the per-viewer divergence with no drop reported at all. The
validator returns the exact string to parse rather than a verdict about a
different one.

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
| `eq null` / `ne null`, and `in`/`notIn` carrying a listed `null` | `IS NULL` / `IS NOT NULL` | the translator forwards a literal `null` rather than coercing it away, and the local evaluator resolves it through `isAbsentContentValue` |
| `ne null` (`isNotNull`) | `IS NOT NULL` | untouched — a union would match every row |
| `gt`, `gte`, `lt`, `lte` — asked for directly | plain predicate | the LOCAL evaluator gained null-awareness |
| `gt`, `gte`, `lt`, `lte` — reached through `not` | `IS NULL OR <predicate>` | server gained the union, so the negation is a true complement |
| `isNull` / `isNotNull` | `IS NULL` / `IS NOT NULL` | the LOCAL evaluator gained null-awareness |

### A value that reads as absent is still a value

`null` in a filter list means "and rows with no value at all". It was silently
discarded in THREE separate layers before this was tracked to one shape: each
layer tested the value for PRESENCE rather than for VALIDITY, and `null` reads
as absent to any check written with truthiness. `normalizedFilterValue` is the
correction — it returns three outcomes, not two: a string, the value `null`, or
`undefined` for genuinely unusable, which is the only case a caller may drop.

Every layer a filter value crosses, and what each does with a `null` entry:

| Layer | Behaviour |
|---|---|
| data-surface `set-filters` → controller | passes through unchanged |
| `sanitizeContentListViewState` | **preserves** it (was: silently dropped) |
| controller state (`setFilters` / `replaceState`) | passes through unchanged |
| URL serialization | writes the `\0` token |
| URL parse | reads the token back as `null` |
| saved-view write (`hydrateDataTableSnapshot`) | JSON, so `null` is native |
| saved-view read | native |
| `restoreContentListSavedView` | preserves it (shares the sanitizer above) |
| translator (`coerceValue`) | **preserves** it (fixed earlier) |
| request → `normalizeFilter` | accepts a null scalar for `eq`/`ne` |
| executor (`conditionToDnf`) | lowers a listed null to `IS NULL` / `IS NOT NULL` |
| local evaluator | `matchesAbsentContentValue` answers the same predicate |

**The URL token is collision-free by construction, not by being unlikely.**
`escapeListEntry` doubles every backslash a real value contains, so the only
two-character sequences a real entry can begin with are `\\` and `\,`. A LONE
backslash followed by `0` is therefore unreachable from any string — including
the literal two characters `\0`, which serialize as `\\0` and read back as
themselves. It survives percent-encoding as `%5C0`. Writing `null` as the word
would have been ambiguous with an author actually called "null".

A **scalar** null comparand needs no token at all: `equals null` and `isNull`
are the same predicate — both lower to `eq null`, and the local evaluator
answers them identically — so it is written as the valueless operator, which
already has a query-string form.

**The bug was never really about `null`.** The same shape catches any value that
a truthiness check reads as absent, so `0`, `false`, and the empty string are
tested alongside it. An empty entry WITHIN a list (`?author.in=a,`) is the empty
string, which is a real value for a column that stores one; an entirely empty
parameter (`?author.in=`) is a list with no values and is still refused and
reported. A blank SCALAR still clears the filter, matching
`applyContentListFilter`.

**A literal `null` has to survive the TRANSLATOR too.** `coerceValue` reports a
null as unusable, which is right for a value that arrived as text and wrong for
one a caller wrote deliberately: dropping it sent `notIn ['Ada']` for
`notIn ['Ada', null]` and returned exactly the rows the caller excluded — the
executor's correct lowering undone one layer up. A literal null is now carried
through `in`/`notIn` lists and accepted as an `equals`/`notEquals` comparand,
and the local evaluator resolves it to absence, so a data-surface `set-filters`
means the same thing in both modes. Such a value cannot arrive from a link or a
saved view — the sanitizer refuses a non-text filter value — so the reachable
path is an agent command.

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
absent value exactly as SQL's three-valued logic does.

**Absence is decided before any text comparison.** The flattened row reads an
absent value as empty text, so comparing it as text answers a question about
`''` rather than about absence — and the two differ for every operator once a
BLANK comparand is involved (`author equals ''` matched an absent row locally
and no row in SQL; `author notEquals ''` did the reverse).
`matchesAbsentContentValue` decides from the operator alone, following the SQL
the executor emits: `equals` matches only a null comparand, `notEquals` matches
unless the comparand is null, `in`/`notIn` turn on whether the list carries a
`null`, and `like` and every ordered comparison match nothing.

**A display fallback is presentation, never data.** Two columns substitute a
label when the content carries no value — `type` reads `content` and `title`
reads `Untitled content`. Comparing the label made `?type=content` return every
untyped row on a client-array list and none on a server-backed one, and made a
search for `untitled` find rows whose title is simply missing.
`comparisonValue()` reads what is stored for those two columns instead: `null`
when the content has no value, empty text when it is genuinely blank, and the
flattened text otherwise, which is already faithful. Both local filtering and
local search go through it. The label keeps rendering; `isNull` is how an
operator asks for the rows behind it. This is the direction the
data means: "no publish date" is not "published before X". It also aligns the
blank-comparand case (`?author.lt=`, `?author.gte=`), where the flattened `''`
used to compare equal and the two modes disagreed, and it leaves a column that
genuinely stores `''` (`title`, `name`) comparing as present in both modes.

**A negation must be a complement.** `not` is part of the endpoint's accepted
grammar even though the translator never emits one, and a direct HTTP consumer
sending `not(gt 'B')` used to get a bare `<= 'B'` — leaving a row with no value
matching NEITHER the predicate nor its negation. `conditionToDnf` therefore
takes a `negated` flag: an ordered comparison reached through an odd number of
`not`s unions `IS NULL`, while the same operator asked for directly does not.
`eq` reached by negating `ne` gets no union, because the complement of
"IS NULL OR <> v" is "= v", which excludes NULL by construction. The executor
tests assert that **every** operator in the grammar partitions the rows against
its own negation — no overlap, no gap — including through `all`/`any`
containers and a double negation. `like` is the sole exclusion: negating one is
refused outright.

The `ne`/`notIn` union costs a second DNF branch each, a negated ordered
comparison costs a second too, and an `all` multiplies,
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

**`undefined` and `[]` mean OPPOSITE things, and getting that backwards is an
authorization fail-open.** A host builds a scope from an allowed-resource list —
the sites, workspaces, or organizations this principal may see:

```ts
const scope = permittedSiteIds.map((siteId) => ({ siteId }));
```

That list is empty exactly when the principal may see nothing. An empty array
therefore means "the set of permitted conditions is empty" and matches no rows;
omit the option entirely to mean "this deployment applies no application
scope". Treating the empty array as absent turned *access to zero sites* into
*access to every row in the tenant* — the precise failure the two-layer scope
design exists to prevent, in the seam chosen as the application's scoping
mechanism.

An empty scope lowers to a predicate that matches nothing (`id IS NULL`, false
for every row on every dialect) rather than throwing: "you may see nothing" is a
legitimate authorization state, and answering it with a 500 would be wrong. It
is ANDed into every branch like any other scope condition, so no caller filter
shape can escape it, and it survives alongside tenancy rather than being
replaced by it. A malformed condition — an empty OBJECT, which states no
constraint at all — is still a programming error and still throws.

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
- `maxResultBytes` on a host-supplied schema must be at least
  `CONTENT_QUERY_MIN_RESULT_BYTES`. The row budget is that number minus the
  envelope reserve, so a smaller one leaves nothing for rows and every query
  answers with an empty page flagged `truncated` — indistinguishable from "no
  content matched". It is refused with a plain `Error` naming the minimum
  rather than a `DataQueryValidationError`, because `schema` is trusted adapter
  configuration: a typed validation error would surface as a 400 and blame the
  caller for the host's mistake.

  **Where this actually runs:** `executeContentQuery` checks it on every
  request, so a misconfigured schema can never serve a query — but through the
  generated route an untyped error becomes an opaque 500, and the message
  naming the minimum reaches only the server log. Call
  `assertContentQuerySchema(schema)` once where the schema is configured to
  fail next to the mistake instead. The check is applied uniformly across query
  modes, `count` included: a schema too small to serve its own row mode is
  misconfigured whatever this request asked for, and letting `count` through
  would hide that until the first rows query. A zero or negative budget is
  refused too — it previously meant "use the default" for rows and "zero
  budget" for facets, which is two answers to one question.
- **A row is never dropped to fit the byte budget — only shortened.** Offset
  paging advances by the requested LIMIT, not by the number of rows actually
  returned, so a dropped row is skipped on its own page and on every page after
  it: silent, permanent data loss. `DataQueryResult`'s offset page is
  `{ kind, offset, limit, hasMore }` with no next-offset slot, and the
  normalizer refuses a `nextCursor` on an offset page, so a continuation offset
  cannot express "resume at 170" either. Instead the page's budget is allocated
  **floor-first, then max-min fair**: every row is seated at its irreducible
  minimum before any surplus is shared, and the surplus goes to the smallest
  APPETITE (cost minus floor) first. Ordering by current cost instead would let
  a row that needs nothing take an even share while a large, mostly-irreducible
  row is starved below its own floor — declaring a feasible page impossible.
  Seating the floors first makes the guarantee unconditional: if the floors fit,
  the page is served. That guarantee lives in `allocateRowBytes`, which is
  exported and unit-tested, because a row's floor is dominated by the
  projection's key bytes — identical across the rows of one page — so the
  disparity that breaks cost-first ordering is not reachable through
  `executeContentQuery` itself.

  Within a row, the fields are levelled to a shared byte cap computed in one
  sorted walk (water-filling), not searched for by halving and re-measuring —
  the old search re-serialized the row and every field on every step, which
  turned an ordinary wide page at the default budget into ~9x the cost of the
  same unbounded read. HOW a field gives way depends on its declared type:

  | declared type | how it gives way | why |
  |---|---|---|
  | `string` | levelled to the shared cap | any prefix of free text is still free text |
  | `datetime` | `null`, or not at all | **no prefix of an RFC 3339 instant is valid** — a shortened one makes the adapter emit a value that breaks the type it declared, and the normalizer then rejects the whole page with `must be an RFC 3339 instant`, blaming the caller |
  | `json` | `null`, or not at all | a document has no incremental shortening |
  | number, boolean, `null` | never | already minimal |
  | the identity field | never | it is the row's address; emptying it fails result normalization |

  The rule generalizes: **a value may be shortened only when its type accepts
  arbitrary prefixes.** Any format-constrained type added later is all-or-nothing
  by default. An all-or-nothing field is dropped only when the row cannot fit
  with it KEPT — losing a whole value to save a few bytes is a last resort, so a
  200 KB `metadata` blob goes immediately while a 26-byte `updated_at` survives
  whenever the strings can absorb the difference.

  Shortening is already a reported state (`truncated` plus its warning) and it
  leaves offset paging exact. Only a page whose FLOORS exceed the budget fails,
  and it fails loudly rather than answering with a page that quietly omits rows.
- A restored page size is clamped to `maxPageSize` (default
  `CONTENT_LIST_MAX_PAGE_SIZE`, 200, matching the schema's `maxPageLimit`), and
  the clamp is reported. The ceiling is resolved once and applied to **both**
  restore paths — a saved view is not a way around a limit a host set for links.
- The server bounds its own answer: it shortens over-long values to fit
  `maxResultBytes`, flagging `truncated` with a warning. It does **not** drop
  rows — see the bullet above — precisely because the next page is computed from
  `page * limit`, so a dropped row would be skipped on the following page too.
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
- The pagers never advertise a page the endpoint cannot fetch. `totalPages` is
  capped at `floor(MAX_OFFSET / pageSize) + 1`. `clampPage` deliberately keeps
  using the TRUE total, so a crafted `?page=` still reaches the query effect and
  gets the notice instead of being silently clamped first. There is only one
  pager to cap, because ContentList renders `<Pagination>` itself in every view
  mode and hands DataTable no total to derive a second page count from.
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

The disabled summary carries a U+001F-prefixed sentinel value rather than a
U+0000 one: the HTML tokenizer rewrites a NUL inside an attribute value to
U+FFFD, so a server-rendered option would hydrate with a value the select was
never given and read as no selection — the exact state the summary exists to
prevent. A client-only mount bypasses attribute parsing, so only a parse
round-trip test catches it.

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
