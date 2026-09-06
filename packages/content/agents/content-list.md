<!-- Module doc for packages/content/AGENTS.md. -->

# ContentList contracts

Read for changes to `src/svelte/content-list-*.ts`, `ContentList.svelte`, or the
server content-query/action adapters. Browser exports come from `/svelte`;
principal-bound query/action factories come from `/server`.

## Ownership and integration

- `content-list-controller.ts` is the shared adapter over `DataTableController`.
  Search, filters, sort, paging, selection, columns, and action eligibility have
  one implementation across grid, detailed, and compact presentations. Controller
  modes are manual. Local arrays use `toContentListRows`, `selectContentListRows`,
  then `paginateContentListRows`; server rows must never be transformed again.
- `query`, `urlState`, `savedViews`, `lifecycle`, `jobs`, and `dataSurface` are
  optional bindings. Without query, rows come from `contents`; with it, contents
  is ignored. `type` locks/hides the type filter; `defaultViewMode` seeds once.
  Existing callbacks (`onEdit`, `onDelete`, `onAdd`, `getViewHref`) remain usable.
- `query.bind()` runs once during component initialization so a structural
  `remoteQuery(collection, transport)` binding registers teardown in that scope.
  Do not import smrt-svelte/web or its browser data runtime into the content
  Svelte barrel: public content pages depend on that code-split boundary.
- The default query transport targets `POST /api/v1/contents/query`.
  `CONTENT_LIST_QUERY_FIELDS` maps column IDs to server fields;
  `ROW_FIELD_TO_CONTENT_KEY` maps response fields to ContentData. For example,
  column `updated`, client `updatedAt`, and server `updated_at` differ.
  `publish` maps to `publish_date`. Derived `site` comes from url/source and has
  no server field; server filtering/sorting on it is dropped and reported.
- Missing/duplicate durable IDs still render with positional keys but are
  `identified: false`. Disable and explain their selection controls. Page select
  all and normalization exclude synthetic IDs; server selection must survive
  page changes, so current-page membership is not a durability test.
- Compact uses content-owned `select` and `actions` columns, included in
  `CONTENT_LIST_TABLE_COLUMN_IDS`. DataTable's generic selection cannot enforce
  per-row eligibility. Resolve links/actions through the shared adapter.

## Paging and freshness

ContentList owns the pager in every presentation and passes no `totalRows` to
DataTable, whose independent clamp would mutate the shared controller without
knowing which query produced a count.

- Clamp on the local full-array count or an exact total for the active settled
  server query only. Never clamp on an estimate, unavailable total, page length,
  previous-query response, or before the current response arrives. An estimate
  may still drive the displayed pager. Test paging in grid and compact modes.
- Resolve one page-size ceiling with `resolveContentListMaxPageSize`: the minimum
  of configured limits and schema limit (default 200). Use it for controller
  seed, URL/saved-view sanitizers, translator, and live state. Server seed defaults
  to 50; null page size becomes the seed and oversized values become the ceiling,
  with reported drops. Local mode may remain unpaginated. Omitted URL size must
  restore the server seed. `setPageSize` resets page.
- Offset only; maximum offset is 1,000,000. Report capping and update the marker
  to `effectivePage`; retain the notice until the operator leaves that page.
  Pager maximum is `floor(MAX_OFFSET / pageSize) + 1`, while clamp uses the true
  total so crafted out-of-range pages receive the explanatory notice.
- Subscribe after the first request; query changes rebind the exact subscription.
  Offline retains usable stale rows. Online calls live `reconnect()` (refresh
  before resubscription), otherwise `refresh()`. Refresh errors are inline over
  retained rows. Show loading, retry, refreshing, last update, offline, truncation,
  and warnings across presentations. Read completeness flags from retry envelopes
  as well as execute envelopes; a successful retry replaces old flags.

## Query authority and protocol

`executeContentQuery()` applies tenancy, failing closed to global rows. Host
application scope comes from authenticated context, never request body; caller
filters only narrow it. Omitted scope means no extra application restriction;
`scope: []` means no permitted rows (`id IS NULL`). AND scope into every query
branch alongside tenancy. Empty object conditions are configuration errors.

Keep field maps, projectable fields, operator/search vocabulary, and mirrored
limits asserted against `buildContentQuerySchema()` and core constants or their
observable acceptance boundaries.

- No cursor paging, body queries, metadata-path filters, or ETag/version slot.
  Read body through GET by ID; use queryFingerprint/freshness.asOf for freshness.
- Search emits an `any` of `like` over title/description/author, escaping caller
  `%`/`_`. Drop and report unsupported `notContains`, datetime LIKE operators,
  invalid datetime inputs, unknown projection fields, and derived site queries.
- Bound normalized request bytes, including default sort. Always emit sort
  (fall back to `CONTENT_LIST_QUERY_DEFAULT_SORT`) so client accounting is not
  smaller than the normalizer's. Limits: 100 list values, 50 filter nodes
  (containers count; search costs four), 128 DNF branches, 50 projection fields
  with 1–256-character IDs, 128-character request ID, 4096 UTF-16 units per scalar,
  100,000 serialized request bytes. Count escapes and surrogate pairs without
  splitting code points. DNF costs include null unions and De Morgan negation.
- Preserve comparands exactly or omit/report the filter. Oversized/unusable `in`
  entries may be removed as a reported subset (`out-of-range`/`unsupported-value`).
  Never partially apply `notIn`: drop/report `filter-widened`. Shed conjuncts for
  node/branch/byte budgets with that same report. Shortened LIKE/search patterns
  report widening; retain leading code points for contains/startsWith and trailing
  ones for endsWith. Never shorten scalar eq/ne/ordered comparands into a value
  the caller did not name. Every change is either exact, a reported superset,
  a reported subset, or a reported omitted predicate.
- Datetimes require a real calendar day, four-digit year, T separator and an
  offset when time is present. Date-only means midnight UTC; minutes without
  seconds and lowercase t/z are accepted. Trim and uppercase before parsing,
  validate that same string, and calendar-round-trip to reject rolled dates.

### Comparison semantics and dialect limits

Fold token filter values (type/status/state); preserve free-text case. Local
text comparison is case-insensitive; server free-text matching follows its SQL
operator/dialect. PostgreSQL/DuckDB LIKE is case-sensitive; SQLite LIKE is ASCII
case-insensitive. Do not promise uniform free-text matching.

SQLite's LIKE lacks the default backslash escape used by PostgreSQL/DuckDB;
escaped wildcards can fail closed there. Fixing portability needs SQL-boundary
ESCAPE support. Null placement is likewise dialect-dependent: local sorts absent
last ascending/first descending, matching PostgreSQL/DuckDB; SQLite defaults
oppositely. The query sort grammar cannot express NULLS FIRST/LAST.

- Read absence from original ContentData, not flattened display text. Type's
  `content` and title's `Untitled content` fallbacks are presentation only; missing
  values compare/search as null, genuinely blank strings remain present.
- eq/in/LIKE exclude absent values unless null is explicitly listed. ne of a
  non-null value and notIn without null include absence. notIn containing null
  excludes absence. eq/ne null lower to IS NULL/IS NOT NULL. Direct ordered
  comparisons exclude absence; their negations include it. Every supported
  predicate and its negation must partition rows without gaps or overlap,
  including nested all/any and double negation. Negated LIKE is refused.
- Preserve literal null through sanitization, saved views, translation and local
  evaluation; only undefined denotes unusable input. Test null, false, zero and
  empty strings. Blank scalar clears a filter; an empty entry within a list is
  real text, but a wholly empty list parameter is refused/reported.

## Result budgets

Call `assertContentQuerySchema(schema)` at configuration time. Every executor
mode, including count, rejects maxResultBytes below
`CONTENT_QUERY_MIN_RESULT_BYTES`; this is a host error, not caller validation.

- Never drop rows to fit bytes: offset advances by requested limit, so omitted
  rows would become unreachable. Seat every row's irreducible floor first, then
  distribute surplus max-min fairly by appetite (cost minus floor).
  `allocateRowBytes` guarantees a page whenever floors fit; otherwise fail loudly.
  Preserve `floor <= cost` and refund the final unused array separator at exact
  byte boundaries.
- Within rows use one sorted water-filling walk. Strings may shorten; datetime
  and JSON values are all-or-nothing (null only if smaller). Numbers, booleans,
  null, and identity never shrink. Prefer shortening free text before losing a
  format-constrained value; new constrained types are all-or-nothing by default.
  Report shortening with truncated/warnings.
- Bound JSON documents before result normalization: strings 65,536 characters,
  containers 1,000 items, depth 16; finite numbers, no cycles, plain values only.
  Drop forbidden __proto__/constructor/prototype keys and build with null
  prototypes. Report truncation rather than allowing one stored document to
  invalidate an entire page.
- Facets share the result byte budget; drop excess facet values and flag both
  facet and result. Per-value caps alone do not bound the envelope.

## URL state and saved views

Read urlState.params once; later onChange(params, state) preserves foreign
parameters and lets the host own routing. `applyContentListViewState` is the
public application boundary: sanitize every patch, including raw saved snapshots,
then merge over current state without resetting restored page. Sanitize the patch,
not the merged result, because selection is intentionally absent from sanitizer
output. Keep raw saved-view payloads so stale-field drops remain reportable.

- Escape list separators and double literal backslashes. List null uses the
  collision-free `\0` token; a literal backslash-zero string is doubled. Scalar
  null serializes through isNull/isNotNull. Preserve foreign parameters by base
  name, even when they have a known operator suffix; unknown suffixed columns
  may still be reported as refused without being deleted.
- The type lock applies to live state, including agent reset/filter commands.
  Fold it into restored patches to preserve paging. Clear it only on an actual
  lock-removal transition, not every unlocked render.
- Toolbar selects must state the live predicate honestly. Unlisted equals values
  render as extra options and produce a notice. Lists, non-equals operators, and
  multiple predicates render a disabled summary and notice. Use operator-aware
  `readContentListSelectFilter`, not value-only `readContentListFilter`.
  Choosing a real option replaces all filters on that column. Summary sentinel
  uses U+001F; NUL changes during HTML parsing and breaks hydration.
- Review is an ordinary status; deleted belongs exclusively to opt-in trash
  mode. Type options are display vocabulary, not the freeform model domain.
  Restore/translation refusals appear in one dismissible notice; stale state
  should still open with the refused parts omitted.

## Shared mutations and lifecycle

Human transports and agent/bulk callers terminate at the same
`createContentListActionAdapter()` instance. Preview/apply is principal-bound;
rendered rows are never mutation authority.

- Supported workflows: trash, draft, review submission, publish, archive, restore,
  automated review, formatting, categorization, optimization. Applications inject
  formatting/optimization handlers; handlers mutate supplied objects but must
  not save them because the adapter owns guarded writes.
- Explicit/current-page/all-matching selections share a default 200-row cap.
  Match server and browser maxSelectionSize. All-matching is canonical query,
  fingerprint and exact count, never browser-page expansion. Above-cap requests
  fail closed, including forged/agent requests; UI asks the operator to narrow.
- Read-only preview returns resolved scope/count/labels/eligibility/consequences.
  Apply uses opaque token and idempotency key, re-resolves query under live
  principal/tenant, rechecks tool/operation permissions and eligibility, and
  compares aggregate updated_at revision. Query/count/membership/row drift fails
  before mutation. Each save also guards updated_at atomically at UPDATE.
  Required projection: id, title, status, updated_at, even under host overrides.
- Publication workflows require every snapshot read permission, explicitly
  including contentassets:read and assets:read. Keep assertions aligned with
  `ContentVersion.createSnapshot()`; embedded adapters rely on them without RLS.
- Declare workflowStorage capability. PostgreSQL, SQLite, ordinary DuckDB and
  non-immediate exported-file modes are supported. JSON default/immediate and
  DuckDB immediate writes are rejected at setup because exports cannot roll back.
- Partial results separate accepted/skipped/failed rows; clear only accepted IDs.
  Failures retain selection. Refresh the exact query and expose progress,
  exceptions, representative labels, resourceType/resourceId and auditReference.

Lifecycle binding enables trash controls; trash mode locks deleted and hides
ordinary status/edit/delete controls. Without it legacy onDelete remains.
`createContentListLifecycleRoute()` mounts POST /api/v1/contents/lifecycle;
its host authenticates every native Request and supplies current action context.
Only move-to-trash, restore, permanent-delete are accepted; malformed/auth/internal
failures use bounded envelopes without private error text.

| Action | Eligible state | Contract |
|---|---|---|
| move-to-trash | not deleted | soft deletion |
| restore | deleted | draft/review/published; recheck permissions and publication readiness |
| permanent-delete | deleted | type exact server count; irreversible |

Permanent DELETE binds updated_at in PostgreSQL's predicate with transactional
cascade; embedded adapters compare under the shared write queue before cascade.
Races return row_revision_drifted. Empty-trash requires exact server count plus
canonical query. Query/selection changes invalidate previews; expiry, stale
revision, row/query/count drift or token failures require new preview. Preview,
initial apply and replay each get distinct attempt request IDs; apply/replay keep
confirmation/idempotency authority, and auditReference identifies original execution.

## Jobs and agent surfaces

- Automated review/formatting/optimization return job IDs. Queue callbacks repeat
  guarded apply with idempotency. Hosts must provide resolveDeferredPrincipal to
  re-resolve the complete live persona/TenantAgent binding; absent, mismatched or
  incomplete bindings fail closed. Authenticated jobStatusPath or client.status
  keeps identical intents locked while running, reconciles terminal outcomes,
  and allows failed/cancelled retry. Disable selection during status requests and
  recheck captured intent before reconciling responses.
- `createContentListJobController().submit({ actionId, submissionKey, target },
  start)` coalesces duplicate active keys; rejected submissions stay failed until
  retry. update(job) cannot regress terminal state. Pending row work disables
  selection/edit/delete. Only succeeded transitions refresh: row targets require
  an affected visible row; query targets require the active request key. Failed
  jobs show error/retry and never masquerade as success.
- Register dataSurface once at ContentList boundary across presentations and
  loading/empty/error states. Publish rendered columns plus required id (hidden
  description stays search-only), explicit fieldName mapping, available operators,
  query fingerprint/total, normalized selection, presentation and freshness.
  Derived site becomes read-only in server mode. Expose only mounted executable
  workflow/lifecycle actions. Context changes advance the same revision stream;
  stale revisions and disconnected registry commands are refused. set-view
  acknowledgements describe accepted state before renderer changes.
- Silent reads use server `createContentListDataSurfaceDefinition({ collection,
  scope })` in createDataSurfaceTools. Resolve collection/scope from live principal;
  executeContentQuery owns rows/counts/facets/offset continuation. Exclude tenant,
  hidden and sensitive fields from discovery/projection. Durable agent mutations
  use the action adapter, never browser registry authority.

## Validation

Use package `pnpm test` (which generates routes through SvelteKit sync), never
bare Vitest. Narrow with `-- <test-file>` to the affected content-list, query,
action, lifecycle or component tests; include both grid and compact paging
scenarios for reachability changes. Run package `pnpm typecheck` for Svelte
changes and root knowledge checks for this module documentation.
