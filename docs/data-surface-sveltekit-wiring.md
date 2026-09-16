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
    // `PrincipalRun.context` is a `SessionPermissionRuntimeContext`, whose
    // database handle is `context.database` (optional — absent when the
    // principal has no bound database session), never `context.db`.
    const db = invocation.run.context.database;
    const candidate = db
      ? await (await CandidateCollection.create({ db })).get(String(rowId))
      : null;
    return candidate?.status === 'pending'
      ? { eligible: true }
      : { eligible: false, reason: 'not_pending' };
  },
  apply: async (invocation, rowId) => {
    const db = invocation.run.context.database;
    if (!db) throw new Error('no bound database session');
    const candidates = await CandidateCollection.create({ db });
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
  const db = invocation.run.context.database;
  if (!db) throw new Error('no bound database session');
  // descriptor.limits.maxSelectionSize is the adapter's own selection-size
  // gate (checked after this resolves) — cap the query at one row past it so
  // a high-cardinality anchor still returns `limit_exceeded` instead of
  // silently materializing an unbounded result set.
  const maxRows = descriptor.limits.maxSelectionSize + 1;
  const rowIds = await resolveBulkExplicitIds(selection.rowIds, {
    // The browser sent one performer id as the "anchor"; expand it to every
    // reference photo currently on file for that performer. SMRT collection
    // filters use the suffixed key form for the IN operator.
    expand: async (anchors) => {
      const photos = await ReferencePhotoCollection.create({ db });
      const rows = await photos.list({
        where: { 'performerId in': anchors },
        limit: maxRows,
      });
      return rows
        .map((row) => row.id)
        .filter((id): id is string => typeof id === 'string');
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

`handlers.preview` and `handlers.apply` are two distinct functions, so the
route layer only needs to call the right one — it never needs to branch on
the request itself. Put the shared handlers in one server-only module:

```typescript
// src/lib/server/data-surfaces/reference-photos-routes.ts
import { createDataSurfaceActionRouteHandlers } from '@happyvertical/smrt-agents/server';
import { referencePhotosAdapter } from './adapter';
import { resolvePrincipalFromEvent } from '$lib/server/auth';

export const referencePhotosActionHandlers = createDataSurfaceActionRouteHandlers({
  adapter: referencePhotosAdapter,
  // Resolve the bound principal (runAsUserId, tenantId, allowedTools, ...)
  // from the request's session/cookie — never trust a client-supplied id.
  // Throw to refuse; the helper turns that into a 401 without ever calling
  // the adapter.
  resolvePrincipal: (request) => resolvePrincipalFromEvent(request),
});
```

Then give preview and apply their own sibling routes, each a one-line call
into the matching handler — the phase is which route file runs, not
something parsed from the request:

```typescript
// src/routes/api/reference-photos/actions/preview/+server.ts
import type { RequestHandler } from './$types';
import { referencePhotosActionHandlers } from '$lib/server/data-surfaces/reference-photos-routes';

export const POST: RequestHandler = ({ request }) =>
  referencePhotosActionHandlers.preview(request);
```

```typescript
// src/routes/api/reference-photos/actions/apply/+server.ts
import type { RequestHandler } from './$types';
import { referencePhotosActionHandlers } from '$lib/server/data-surfaces/reference-photos-routes';

export const POST: RequestHandler = ({ request }) =>
  referencePhotosActionHandlers.apply(request);
```

A `[phase]` dynamic route segment (validated to only `preview` or `apply`
before dispatch) works the same way if the app prefers one route file. What
does not work is inferring the phase from a single shared route's `url` —
the request body's own `phase` field is for the adapter's internal
consistency check, not for routing, so the route itself must determine which
handler to call.

## 4. Handle refusals in the browser client

`createDataSurfaceActionRouteHandlers()` maps every adapter refusal reason to
an HTTP status so a client can branch on `response.status` without parsing
the body for common cases. There are two distinct body shapes, and only one
of them carries `reason`:

- **Route-level refusals** — an oversized body (413) or a `resolvePrincipal`
  throw (401) — never reach the adapter, so the body is `{ error: string }`
  (`error: 'payload_too_large'` or `error: 'unauthorized'`). There is no
  `reason` field on these responses.
- **Adapter results** — everything the adapter itself returned or refused —
  are a full `DataSurfaceActionResult`, whose `reason` is optional: present
  on every refusal (`ok: false`), typically absent on success (`ok: true`).

| `reason` (adapter result) or `error` (route-level) | status | meaning |
| --- | --- | --- |
| `error: 'payload_too_large'` | 413 | body exceeded the request-byte cap before it was parsed |
| `error: 'unauthorized'` | 401 | `resolvePrincipal` refused |
| `invalid_request` | 400 | malformed body; a client bug, not a retry |
| `denied` | 403 | RBAC/tool/domain authorization refused (including an authorization error thrown by `assertToolAllowed`/`assertOperation`, which this helper catches and maps) |
| `not_found` / `unsupported` | 404 | surface, action, or identity mismatch |
| `selection_not_supported` | 400 | action does not support this selection scope |
| `limit_exceeded` | 413 | selection exceeds `descriptor.limits.maxSelectionSize` |
| `stale_revision` / `stale_preview` | 409 | re-preview: the surface changed since the client last read it |
| `confirmation_required` / `confirmation_mismatch` / `confirmation_replayed` / `invalid_or_expired_confirmation` | 409 | re-preview to get a fresh confirmation token |
| `idempotency_conflict` | 409 | same idempotency key reused for a different logical request — use a new key |
| `idempotency_in_progress` | 202 | another attempt with this key is in flight; retry the same request with the same key |
| `background_unavailable` | 503 | queue/signing-key misconfiguration on the server; not a client-fixable state |
| anything else | 422 | a domain-specific refusal from `mapError()`; treat as terminal for this request |

Only `idempotency_in_progress` is retryable by the client, and only with the
**same** `idempotencyKey` — it means another attempt with that key is still
being reserved or executed, so the client should back off and retry the
identical request. `idempotency_conflict` is **terminal**: it means the same
key was already used for a logically different request (a different action,
selection, or payload), and the state store's contract enforces that the
first request's fingerprint owns the key permanently — retrying it, with or
without changes, cannot succeed. Use a new idempotency key for a distinct
logical operation.

An orphaned reservation (the process that reserved a key crashed or was
killed mid-mutation, with unknown external effects) does **not** expire on
its own — the state store deliberately never times out a reservation whose
side effects are unknown, so a same-key retry from the client keeps
returning `idempotency_in_progress` forever. Recovering it is an operator
action, not a client retry: call `createSqlDataSurfaceActionStateStore()`'s
`reconcileIdempotency()` with live-authority evidence for the exact request
fingerprint and reservation timestamp (e.g. a confirmed durable-queue job
outcome, or a manual on-call check against the actual mutated rows), which
settles the reservation to a terminal completed/failed result before any
further attempt with that key can proceed. See
[Refusal behavior](./data-surface-conformance.md#refusal-behavior) for the
full contract this reuses.

## Testing this wiring

Follow `packages/agents/src/server/sveltekit-data-surface-routes.integration.test.ts`
for the pattern: build a real SQLite-backed collection and
`createJobsDataSurfaceBackgroundQueue`, drive the route handlers with plain
`Request` objects, and run a real `TaskRunner` to prove the background job
executes and a retried apply replays instead of re-mutating.

Every code sample above is mirrored, verbatim in substance, in
`packages/agents/src/server/__typecheck__/sveltekit-data-surface-routes-doc-examples.ts`,
which `tsc --noEmit` compiles as part of the package (it is never imported or
executed). Keep that file in sync with this guide — a sample that does not
type-check there means the guide is wrong.
