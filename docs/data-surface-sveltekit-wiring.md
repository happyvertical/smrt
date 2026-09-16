---
sidebar_position: 7
---

# SvelteKit wiring for data-surface actions (#2907)

`@happyvertical/smrt-agents/server` already owns every principal, idempotency,
and durable-queue rule for a data-surface action: `createDataSurfaceActionAdapter()`
does preview/apply orchestration, and `createJobsDataSurfaceBackgroundQueue()`
persists background work in `@happyvertical/smrt-jobs`. What was missing was a
documented, copy-pasteable pattern for the last mile — a SvelteKit
`+server.ts` route — so each application was reinventing principal resolution,
body parsing, and refusal-to-HTTP-status mapping per action.

This guide wires the chain end to end:

```
+server.ts  →  createDataSurfaceActionRouteHandlers  →  createDataSurfaceActionAdapter
                                                            │
                                                            └─▶ createJobsDataSurfaceBackgroundQueue
```

`createDataSurfaceActionRouteHandlers()` (from `@happyvertical/smrt-agents/server`)
is the only new surface. It takes a plain `Request` and returns a plain
`Response` — it has no `@sveltejs/kit` dependency — so a SvelteKit
`RequestHandler` is a one-line adapter around it.

## 1. Define the action

An action definition is application-owned: it declares its `tool`/`operation`
RBAC gate, its confirmation policy, and how to authorize, check eligibility,
and mutate one row. Keep it in a server-only module.

```typescript
// src/lib/server/data-surfaces/candidates-actions.ts
import type { DataSurfaceServerActionDefinition } from '@happyvertical/smrt-agents/server';
import { CandidateCollection } from '$lib/server/candidates';

export const approveCandidate: DataSurfaceServerActionDefinition = {
  descriptor: {
    id: 'approve',
    label: 'Approve',
    selectionScopes: ['explicit-ids'],
    requiresConfirmation: true,
  },
  inputSchema: null,
  validatePayload: () => ({ valid: true }),
  confirmation: 'required',
  execution: 'foreground', // row actions are usually synchronous
  tool: 'mam.candidates.approve',
  operation: { id: 'candidates:update', collection: 'candidates', action: 'update' },
  authorize: () => true, // RBAC already gated by `operation`; add domain rules here
  eligible: async (invocation, rowId) => {
    const candidate = await invocation.run.context.db
      ? (await CandidateCollection.create({ db: invocation.run.context.db })).get(String(rowId))
      : null;
    return candidate?.status === 'pending'
      ? { eligible: true }
      : { eligible: false, reason: 'not_pending' };
  },
  apply: async (invocation, rowId) => {
    const candidates = await CandidateCollection.create({ db: invocation.run.context.db });
    const candidate = await candidates.get(String(rowId));
    if (!candidate) throw new Error('candidate vanished');
    candidate.status = 'approved';
    await candidate.save();
    return undefined;
  },
};
```

### Bulk-scope example: apply-look over a reference-photo set

A bulk action (anytown's "apply this look to every reference photo for a
performer") takes one anchor id from the browser and resolves the full
mutation set **on the server**, so a single idempotency key covers the whole
set and the browser never has authority over which rows are included. Use
`resolveBulkExplicitIds()` in the surface's `resolveSelection` seam:

```typescript
// src/lib/server/data-surfaces/reference-photos-surface.ts
import { resolveBulkExplicitIds } from '@happyvertical/smrt-agents/server';
import type { ResolvedDataSurfaceActions } from '@happyvertical/smrt-agents/server';

export async function resolveReferencePhotosSurface(run, identity) {
  // ... build `descriptor` and `actions` as usual ...
  return {
    descriptor,
    revision: await currentRevision(run),
    actions: { 'apply-look': applyLookAction },
  } satisfies ResolvedDataSurfaceActions;
}

export async function resolveReferencePhotosSelection(invocation, selection) {
  if (selection.scope !== 'explicit-ids') {
    return { revision: 1, queryFingerprint: 'n/a', rowIds: [] };
  }
  const rowIds = await resolveBulkExplicitIds(selection.rowIds, {
    // The browser sent one performer id as the "anchor"; expand it to every
    // reference photo currently on file for that performer.
    expand: async (anchors) => {
      const photos = await ReferencePhotoCollection.create({ db: invocation.run.context.db });
      const rows = await photos.list({ where: { performerId: { in: anchors } } });
      return rows.map((row) => row.id);
    },
  });
  return { revision: 1, queryFingerprint: 'reference-photos-v1', rowIds };
}
```

Every row in the expanded set is previewed together and, on apply, executes
under the **same** `idempotencyKey` — a retry replays the recorded result
instead of re-running or double-charging any row.

## 2. Wire the adapter and the durable queue

```typescript
// src/lib/server/data-surfaces/adapter.ts
import {
  createDataSurfaceActionAdapter,
  createJobsDataSurfaceBackgroundQueue,
  createSqlDataSurfaceActionStateStore,
} from '@happyvertical/smrt-agents/server';
import { getAppDb } from '$lib/server/db';
import { DATA_SURFACE_ENVELOPE_SIGNING_KEY } from '$lib/server/secrets';
import { resolveReferencePhotosSurface, resolveReferencePhotosSelection } from './reference-photos-surface';

const db = await getAppDb();

export const referencePhotosAdapter = createDataSurfaceActionAdapter({
  state: createSqlDataSurfaceActionStateStore({ db }),
  resolveSurface: resolveReferencePhotosSurface,
  resolveSelection: resolveReferencePhotosSelection,
  backgroundHandlerId: 'reference-photos-actions-v1',
  deferredEnvelopeSigningKey: DATA_SURFACE_ENVELOPE_SIGNING_KEY, // >= 32 bytes, server-only
  resolveDeferredPrincipal: async (reference) => resolvePrincipalFromReference(reference),
  backgroundQueue: createJobsDataSurfaceBackgroundQueue({
    db,
    handlerId: 'reference-photos-actions-v1',
    execute: (envelope) => referencePhotosAdapter.executeDeferred(envelope),
  }),
});
```

Register the same `backgroundHandlerId` in every worker process (including a
standalone job-runner process, if the app has one) — `createJobsDataSurfaceBackgroundQueue()`
re-registers the handler on each call, so importing this module anywhere a
job can run is enough. Use `createSqlDataSurfaceActionStateStore()` in
production; `InMemoryDataSurfaceActionStateStore` is single-process and
test-only.

## 3. Wire the route

```typescript
// src/routes/api/reference-photos/actions/+server.ts
import { createDataSurfaceActionRouteHandlers } from '@happyvertical/smrt-agents/server';
import type { RequestHandler } from './$types';
import { referencePhotosAdapter } from '$lib/server/data-surfaces/adapter';
import { resolvePrincipalFromEvent } from '$lib/server/auth';

const handlers = createDataSurfaceActionRouteHandlers({
  adapter: referencePhotosAdapter,
  // Resolve the bound principal (runAsUserId, tenantId, allowedTools, ...)
  // from the request's session/cookie — never trust a client-supplied id.
  // Throw to refuse; the helper turns that into a 401 without ever calling
  // the adapter.
  resolvePrincipal: (request) => resolvePrincipalFromEvent(request),
});

export const POST: RequestHandler = ({ request, url }) => {
  const phase = url.pathname.endsWith('/preview') ? 'preview' : 'apply';
  return phase === 'preview' ? handlers.preview(request) : handlers.apply(request);
};
```

A common layout is two sibling route files sharing the same handlers object:
`src/routes/api/reference-photos/actions/preview/+server.ts` calls
`handlers.preview`, and `.../apply/+server.ts` calls `handlers.apply`. Either
layout is fine — the helper does not care how the app splits preview and
apply across routes, only that each call passes the matching `phase` in the
request body (`DataSurfaceServerActionRequest.phase`), which the shared
`DataSurfaceActionAdapter` also validates.

## 4. Handle refusals in the browser client

`createDataSurfaceActionRouteHandlers()` maps every adapter refusal reason to
an HTTP status so a client can branch on `response.status` without parsing
`reason` for common cases (though `reason` is always present in the body for
logging/telemetry):

| `reason` | status | meaning |
| --- | --- | --- |
| `invalid_request` | 400 | malformed body; a client bug, not a retry |
| `unauthorized` (route-level) | 401 | `resolvePrincipal` refused |
| `denied` | 403 | RBAC/tool/domain authorization refused |
| `not_found` / `unsupported` | 404 | surface, action, or identity mismatch |
| `selection_not_supported` | 400 | action does not support this selection scope |
| `limit_exceeded` | 413 | selection exceeds `descriptor.limits.maxSelectionSize` |
| `stale_revision` / `stale_preview` | 409 | re-preview: the surface changed since the client last read it |
| `confirmation_required` / `confirmation_mismatch` / `confirmation_replayed` / `invalid_or_expired_confirmation` | 409 | re-preview to get a fresh confirmation token |
| `idempotency_conflict` | 409 | same idempotency key reused for a different logical request — use a new key |
| `idempotency_in_progress` | 202 | another attempt with this key is in flight; retry the same request with the same key |
| `background_unavailable` | 503 | queue/signing-key misconfiguration on the server; not a client-fixable state |
| anything else | 422 | a domain-specific refusal from `mapError()`; treat as terminal for this request |

`idempotency_in_progress` and `idempotency_conflict` are the only two that
should ever prompt a client-side retry, and only with the **same**
`idempotencyKey` — see
[Refusal behavior](./data-surface-conformance.md#refusal-behavior) for the
full contract this reuses.

## Testing this wiring

Follow `packages/agents/src/server/sveltekit-data-surface-routes.integration.test.ts`
for the pattern: build a real SQLite-backed collection and
`createJobsDataSurfaceBackgroundQueue`, drive the route handlers with plain
`Request` objects, and run a real `TaskRunner` to prove the background job
executes and a retried apply replays instead of re-mutating.
