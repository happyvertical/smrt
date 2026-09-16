---
sidebar_position: 6
---

# Data-surface conformance

Data surfaces are one contract shared by a human UI, browser commands, and
principal-bound agent tools. The application owns the catalog and executor;
the framework owns normalization, bounds, and refusal behavior.

## Integration contract

1. Build a server-owned `DataSurfaceDefinition` for each readable resource.
   Keep tenant and principal scope in the executor context. `data.discover`
   and `data.query` are evaluated as the bound principal, and sensitive fields
   are removed before a descriptor or row crosses the tool boundary. For any
   registered `SmrtObject` collection that isn't `Content`, build this from
   `createSmrtCollectionDataSurfaceDefinition()` (`@happyvertical/smrt-agents`,
   `packages/agents/src/smrt-collection-data-surface.ts`, #2905) rather than
   hand-writing schema/redaction/filter logic per collection: it derives the
   bounded schema from `ObjectRegistry.getAllFields()`, applies the same
   `sensitive`/`readPermission` redaction as the Content adapter, and executes
   through `collection.list/count/facets` with tenant scope, an
   application-supplied scope, offset and opaque-cursor paging, projection,
   sort, filters (`all`/`any`/`not`/condition, lowered to bounded DNF), facets,
   and freshness/total metadata. Tenant scoping is class-aware: a
   `@TenantScoped()` class is scoped on its configured tenant field (which is
   also excluded from the derived schema), and an unscoped class gets no
   tenant condition at all. Opaque cursors are bound to the exact normalized
   request and merged scope that produced them (via a `binding` fingerprint),
   so a cursor is rejected if the filter, sort, or tenant changes, or if it is
   forged or replayed against a different query. `facets` capability defaults
   from the collection's own shape (`typeof collection.facets === 'function'`
   for a static collection; a resolver-backed collection must set
   `facets: false` explicitly if its resolved collection lacks `facets()`).
   Because `SmrtCollectionQueryCollection` is structural, the adapter cannot
   read a host collection's own row-limit cap — callers MUST keep
   `maxPageLimit` at or below that cap, or a silently clamped page is
   detected and reported via a result warning rather than corrected.
   `@happyvertical/smrt-content`'s `createContentListDataSurfaceDefinition()`
   remains its own adapter (see the module doc comment in
   `smrt-collection-data-surface.ts`, and follow-up #2912, for why it is not
   yet a thin wrapper over the generic one).
2. Mount a `DataSurfaceDescriptor` on `DataTable` (or a ContentList/report
   adapter) using the same identity, row key, version, schema version, and
   column capabilities. Human header interactions and registry commands must
   update the same controller snapshot. A page with its own hand-rolled list
   markup that already mirrors a headless `DataTableController`'s
   search/filters/sort/page/selection should not hand-write this registration
   itself — `mountListDataSurface()`
   (`@happyvertical/smrt-svelte/web`, `packages/smrt-svelte/src/web/list-data-surface.svelte.ts`,
   #2906) is a same-behavior port of `registerContentListDataSurface`'s
   registration/translation logic, generalized off ContentList's view-mode
   concept. The two copies are not yet unified behind a shared
   `@happyvertical/smrt-ui/data` implementation (#2917), and are not
   currently identical — see that module's doc comment for the specific
   divergences #2917 must reconcile. It mirrors the controller into the
   registry, translates
   visible table commands back into controller dispatches (denying anything a
   descriptor or `acceptsTableCommand` predicate does not allow), and bumps a
   monotonic per-identity revision on every controller change it observes
   automatically. App-owned context (`totalRows`, freshness, a query
   fingerprint, …) is a one-time snapshot at mount, not observed — the page
   must call the returned handle's `update()` whenever that state changes, or
   the published context goes stale while the controller-driven half of the
   same snapshot stays live (an `$effect` keyed on those values is the usual
   place). It routes the fixed `refresh`/`retry`/`focus`/`reveal`/`highlight`
   controls to page callbacks, and dispatches any other `controlId` through
   an `onControl` escape hatch (denied by default). If `controller` is controlled
   (`controller.isControlled()`), `dispatch()` only proposes state via
   `onStateChange` and never applies it, so `applyControlledState` is
   required to settle the candidate state — mirroring `DataTable`'s own
   controlled-table contract — or every table command is denied once
   dispatched. Call it during component initialization and `destroy()` the
   returned handle on unmount; it touches neither `window` nor `document`,
   so it works the same under SSR and `ssr = false` SPAs.
3. Send visible commands through the authenticated bridge. The browser may
   return a snapshot as an acknowledgement, but it cannot grant permissions;
   server authorization runs before bytes are sent and bridge acknowledgements
   are checked for session, source, expiry, identity, and revision.
4. Require preview for sensitive/destructive actions. Apply receives an opaque,
   principal/tenant/query/revision-bound token and an idempotency key. Recheck
   authorization and row eligibility during apply; replaying a token or using
   a stale selection fails closed.

Queries must declare a bounded page (offset or opaque cursor), projection, and
freshness metadata. Executors receive an `AbortSignal`; the deadline cancels
slow work. Results must report exact/estimated totals, truncation, and short
warnings without leaking SQL, authority, or another tenant's rows.

## Refusal behavior

Treat `not_found`, `denied`, `stale_revision`, `expired`, `timeout`,
`disconnected`, `invalid_request`, `idempotency_conflict`, and
`confirmation_replayed` as terminal failures for that request. If an apply
outcome is unknown, retry the exact same logical request with its original
idempotency key so the server can safely return the recorded result. Use a new
idempotency key only for a distinct logical operation, and obtain a fresh
preview whenever confirmation is required for that operation.

The app-level regression gate is
`packages/smrt-svelte/src/web/__tests__/data-surface-conformance.integration.svelte.test.ts`.
It uses a real SQLite collection and generated REST handler, mounts a real
DataTable, exercises ContentList/report descriptors, and covers the refusal,
pagination, cancellation, accessibility, and opaque-confirmation paths.

All wire descriptors are versioned (`version: 1`). Additive fields require
normalizer and packed-export coverage; incompatible changes require a new
version and an explicit adapter migration.
