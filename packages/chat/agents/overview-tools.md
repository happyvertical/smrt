# Overview assistant tools (#3727 phase 4)

`createOverviewTools({ host, undoStore?, audit?, maxOperations? })`
(`src/overview-tools.ts`, package index) returns three `PrincipalTool`s for the
persona / assistant-route `extraTools` seam. They let the assistant add and
configure widgets on a customizable overview page ("add a chart of overdue
invoices") with structured operations, and undo its last change. The overview
model, widget registry and option schemas are smrt-svelte's
([overview-surfaces.md](../../smrt-svelte/agents/overview-surfaces.md)).

| Slug (function name) | Arguments | Result |
|---|---|---|
| `overviews.describe` (`overviews-describe`) | `{ page? }` | `{ page, overview }`: allowed widget types with option fields (type, required, default, range, `choices`, page `models`), span range, the current widgets in order, `canCustomize`. Without `page`: `{ pages }` from `host.pages` |
| `overviews.apply` (`overviews-apply`) | `{ page, operations }` | `{ page, changed, applied: [{ index, op, id }], undoToken, overview }`; `changed: false` and `undoToken: null` for a batch that changes nothing |
| `overviews.undo` (`overviews-undo`) | `{ page, undoToken }` | `{ page, undone: true, overview }` |

Operations (1 to `maxOperations`, default 20): `add { type, span?, options?,
index? }`, `configure { id, options }` (merged onto the current options; `null`
clears a key to its default), `move { id, index }`, `resize { id, span }`,
`remove { id }`. Option values are JSON primitives over the widget's closed
field vocabulary; there is no query, filter expression, URL or SQL anywhere.

## Authority

- **The host decides, per principal.** `host.open(run, pageId)` returns the
  page for that `PrincipalRun` or `null` (unknown and not offered answer the
  same 404). Build it with smrt-svelte's `createOverviewAssistantSurface`
  (`./overview/server`) from the page's `OverviewDefinition`, the
  principal's own stored override, `canCustomize` from the principal's role,
  and `persist`. Never derive any of these from model input except the page id.
- **Tenant.** Like the runtime-report tools, with tenancy on a run without
  `run.context.tenantId` is refused (403 `tenant_required`), `host.open` and
  every surface call (including `persist`) run under the principal's tenant
  (entered when no tenant context is active), and an ambient tenant that
  differs from the principal's is refused (`DataSurfaceDeniedError`) unless
  the caller is in a system-context or super-admin path. The host scopes its
  reads and writes by `run.context.tenantId`.
- **Validation is the overview model's.** The surface plans each batch with
  `planOverviewOperations` and checks the result with `checkOverviewOverride`
  (allowed set and `allowedIn`, page-confined `models`, option schemas, span
  ranges, the widget cap), so the assistant can only store an override the
  page's own save endpoint accepts. A batch is atomic.
- **Errors** are `OverviewToolError` with `status`, `code`, `publicMessage`,
  `issues`. `runToolLoop` classifies 404/409/422 as `invalid_request` (the model
  sees `publicMessage`, which lists every issue as `#<n> <op>: <message>`, and is
  told to fix and retry) and 403 as `not_permitted`. Codes: `invalid_page`,
  `invalid_operations` (422), `unknown_page` (404), `tenant_required` (403),
  `not_allowed` (403,
  `canCustomize` false, on apply and on undo), `conflict` (409, apply lost a
  race with another save), `nothing_to_undo`, `changed_since`,
  `cannot_restore` (409).
- **Writes are conditional.** `surface.persist(override)` answers
  `OverviewToolPersistResult` (`{ ok: true }` or `{ ok: false, reason:
  'conflict' | 'not_allowed' | 'invalid', issues? }`) and must write only if
  the stored row is still the revision the surface was opened on. A save that
  lands between `host.open` and the write is a `conflict`: apply answers 409
  `conflict` (describe again, rebuild the batch), undo answers 409
  `changed_since` and keeps its entry. smrt-svelte's surface takes the loaded
  `revision` and passes `{ revision }` to its `persist` option, so the
  revision-guarded `save` of `@happyvertical/smrt-preferences`'
  `createOverviewStore` plugs in directly (see below).
- **Undo** is single-step. Apply stores `{ token, before, after }` under
  `[tenantId, userId, pageId]` of the calling run; undo looks it up under the
  calling run only, so another principal's (or tenant's) token is simply not
  found. It refuses when the stored override is no longer `after` (someone
  changed the page since), re-checks `before` with `check`, persists it
  conditionally, and deletes the entry only after that write succeeded.
  Removal is compare-and-delete: `OverviewUndoStore.delete(key, token)` is a
  no-op unless the stored entry still carries that token, so an undo that
  finishes after a newer batch stored its entry never removes that entry.
- **The undo store must outlive a request and a turn.** Without `undoStore`
  the tools use `defaultOverviewUndoStore()`, one in-memory store per process
  (30-minute TTL, 1000 keys), so tools built per turn
  (`extraTools: (context) => createOverviewTools(...)`) still undo an earlier
  turn's batch. Never pass a store created inside the per-turn factory. A
  multi-replica host passes one shared `OverviewUndoStore`, created once,
  whose `delete(key, token)` is an atomic conditional delete.
- **After a successful write the call never fails.** The undo entry is written
  after the write; if the store throws, apply still answers `changed: true`
  with `undoToken: null` and a `note` not to apply the batch again (a lost entry
  only costs the Undo, while an entry written first could later restore over a
  value the batch never wrote). Audit is best effort; failures go to
  `onError` (default `console.warn`).

## Wiring to persistence (phase 3)

The surface is the only seam; this package has no table and no dependency on
smrt-svelte or `@happyvertical/smrt-preferences` (smrt-svelte depends on chat
for tests, so the types are structural). Phase 3 stores overview layouts in
`@happyvertical/smrt-preferences` (table `_smrt_ui_preferences`, preference
kind `overview`); its overview layer is `createOverviewStore({ db })`, built
over the generic `createPreferenceStore({ db })` (pass `preferences` to share
one). Every store call acts as the ambient principal, which is the run's
principal inside the tool loop, under the tenant the tools enter.

```ts
import { createOverviewTools } from '@happyvertical/smrt-chat';
import {
  createOverviewStore,
  withTenantDefaults,
} from '@happyvertical/smrt-preferences';
import { createOverviewAssistantSurface } from '@happyvertical/smrt-svelte/overview/server';

// Module scope: created once, shared by every turn and request.
const overviewUndo = createSharedOverviewUndoStore(); // or omit for the process default

const overviewTools = (db: DatabaseInterface /* per turn */) => {
  const store = createOverviewStore({ db });
  return createOverviewTools({
    undoStore: overviewUndo,
    host: {
      async open(run, pageId) {
        const definition = overviewDefinitions.get(pageId);
        if (!definition) return null;
        const state = await store.load(definition, registry);
        if (!state.user) return null;
        return createOverviewAssistantSurface({
          // The user tier is a delta over the tenant default.
          definition: withTenantDefaults(definition, state.tenant.document),
          registry,
          override: state.user.override,
          revision: state.user.revision,
          canCustomize: state.canCustomize.user,
          // The page definition: the store merges the tenant tier itself.
          persist: (override, { revision }) =>
            store.save(definition, registry, { scope: 'user', override, revision }),
        });
      },
    },
  });
};
```

`createSharedOverviewUndoStore` stands for the host's own shared store (any
`OverviewUndoStore`). How the store's answer maps onto the tools:

| `store.save(definition, registry, { scope, override, revision })` (`OverviewSaveResult`) | Surface / tool |
|---|---|
| `{ ok: true, override, revision }` | the surface follows the new `revision`; apply answers `changed: true` |
| `{ ok: false, reason: 'conflict' }` (the loaded `revision` is stale, or a first write raced another; nothing is overwritten) | apply: 409 `conflict`; undo: 409 `changed_since`, entry kept |
| `{ ok: false, reason: 'not_allowed' }` (no `overviews.personalize` / `overviews.customize`) | 403 `not_allowed` |
| `{ ok: false, reason: 'invalid', issues }` (`checkOverviewOverride` refused it) | 422 `invalid_operations` |

`revision` is `null` when the principal had no row yet; the first write then
creates it, and a concurrent first write answers `conflict`. Add the three
slugs to the persona's / route's `allowedTools`.

## In the browser

When the overview is mounted on the page the dock runs on, use the browser
tools instead: smrt-svelte's `createOverviewAssistant(controller)` +
`useOverviewAssistantTools` register `overview_describe`, `overview_apply` and
`overview_undo` as page tools (add `overview_*` to the route's
`clientToolAllowList`). A batch lands through `controller.restore`, so the grid
updates live and the host's `onchange` persists it, and `OverviewAssistantUndo`
(or a toast) offers Undo. Same operations, same validation, same error shape
(returned as JSON, not thrown).

Tests: `src/overview-tools.test.ts` (contract against a structural surface) and
`packages/smrt-svelte/src/components/overview/__tests__/assistant-tools.integration.test.ts`
(these tools over the real model).
