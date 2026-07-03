# Sync-Apply Batch Write Contract

The idempotent batch write endpoint (#1759) is the **single shared write
contract** for durable client mutation queues. It has exactly two intended
consumers, and this page is written for both:

- the **web offline outbox** in `@happyvertical/smrt-web`
  ([#1762](https://github.com/happyvertical/smrt/issues/1762)) — TanStack-based
  durable browser outbox with FIFO replay, and
- the **KMP mobile write queue**
  ([#1739](https://github.com/happyvertical/smrt/issues/1739), ADR
  [0001 KMP Mobile Foundation](../adr/0001-kmp-mobile-foundation.md)) — the
  SQLDelight-backed queue with the
  `pending → uploading → synced → failed` state machine.

One contract, two client runtimes: replay semantics are designed once here so
web and mobile cannot drift (parent PRD:
[#1755](https://github.com/happyvertical/smrt/issues/1755)).

## Endpoint

| Generator | Route | Notes |
|---|---|---|
| Runtime REST generator (`APIGenerator`) | `POST {basePath}/sync/apply` (default `POST /api/v1/sync/apply`) | Always available; `sync` is a **reserved** path segment under the base path. |
| SvelteKit generator (vite plugin) | `POST {routesDir}/sync/apply` (default `POST /api/sync/apply`) | Generated as `sync/apply/+server.ts` when at least one model is syncable. A hand-written file at that path is never overwritten (a warning is logged instead). |

Both transports delegate to the same engine —
`processSyncApplyBatch()` in `@happyvertical/smrt-core` (`src/sync/apply.ts`)
— so behavior is identical by construction.

A model is **syncable** when its `@smrt({ api })` config is enabled and
exposes at least one of `create` / `update` / `delete`. Ops excluded from the
API config are rejected per-item (`op_not_allowed`) exactly as the CRUD routes
would 405 them.

## Request

```jsonc
POST /api/v1/sync/apply
{
  "items": [
    {
      "itemId": "0d5e6f3a-…",          // client idempotency/correlation handle
      "object": "products",            // collection route segment
      "op": "create",                  // "create" | "update" | "delete"
      "id": "3f0d8a4e-…",              // client-generated row UUID (validated)
      "payload": { "name": "Widget" }, // field data (create/update)
      "baseUpdatedAt": "2026-07-02T10:00:00.000Z" // optional conflict guard
    }
  ]
}
```

Per-item fields:

| Field | Required | Semantics |
|---|---|---|
| `itemId` | yes | The client's handle for this mutation — use the durable queue row id. Echoed back verbatim; **results are also positional** (`results[i]` ↔ `items[i]`). Not interpreted by the server. |
| `object` | yes | The **collection route segment** the model's generated CRUD routes use (e.g. `products`) — the same string as in `GET /api/v1/products`. |
| `op` | yes | `create`, `update`, or `delete`. |
| `id` | yes | The client-generated row UUID. Must be a well-formed UUID (`8-4-4-4-12` hex); malformed ids are rejected per-item (`invalid_id`). This envelope field is the **only** channel for a client-supplied id — see [Mass-assignment guard](#mass-assignment-guard-1540) below. |
| `payload` | create/update | Plain object of field values, exactly like a CRUD create/update body. Ignored for `delete`. |
| `baseUpdatedAt` | no | ISO-8601 timestamp: the server `updated_at` the client last saw for this row. Drives the [conflict guard](#conflict-policy-v1-server-authoritative-lww) on `update`/`delete`. Omit to opt out of conflict detection (blind last-write). |

Batch-level constraints (violations return **HTTP 400** with
`{ "error": { "code", "message" } }`; nothing is applied):

- body must be an object with an `items` array (`invalid_batch`),
- at most **1000 items** per batch (`batch_too_large`),
- body must be valid JSON.

Everything else — including authorization failures — is reported **per item**
in an HTTP 200 response, because authorization is per-object and one item's
failure must never fail the batch.

## Response

```jsonc
HTTP 200
{
  "results": [
    {
      "itemId": "0d5e6f3a-…",
      "id": "3f0d8a4e-…",
      "status": "applied",                          // "applied" | "conflict" | "rejected"
      "reason": "stale_write",                      // machine-readable; present for conflict/rejected
      "updatedAt": "2026-07-02T10:00:01.234Z"       // server updated_at; see below
    }
  ]
}
```

- `results[i]` always corresponds to `items[i]`. `itemId` is echoed as a
  convenience (`null` when the item was too malformed to carry one).
- `updatedAt` is the server row's `updated_at` **after** processing. It is
  present on applied creates/updates and on conflicts (so the client can
  rebase), and absent on deletes and rejections. Clients should persist it as
  the new `baseUpdatedAt` for future edits of that row.

### Status and reason reference

| Status | Reason | Meaning |
|---|---|---|
| `applied` | — | The mutation's effect is present (freshly written, or already present from an earlier delivery — a no-op re-apply). Deletes of rows that are already gone are `applied`. |
| `conflict` | `stale_write` | `baseUpdatedAt` is older than the server row's `updated_at`. The write was **skipped** (server state wins); `updatedAt` carries the server's current value. |
| `conflict` | `create_conflict` | A create targeted an existing row whose content differs from the payload. The create was **skipped** (server state wins). |
| `rejected` | `invalid_item` | Malformed envelope (missing/invalid `itemId`, `op`, `object`, or unparseable `baseUpdatedAt`). |
| `rejected` | `invalid_id` | The row id is not a well-formed UUID. |
| `rejected` | `invalid_payload` | `payload` missing or not an object on create/update. |
| `rejected` | `unknown_object` | No model matches the `object` segment. |
| `rejected` | `op_not_allowed` | The model's API config does not expose this op. |
| `rejected` | `auth_required` | No authenticated principal (and the model is not `public: true`), or the auth middleware answered 401. |
| `rejected` | `forbidden` | The auth middleware refused with a non-401 status. |
| `rejected` | `not_found` | Update target does not exist — or is not visible in the caller's tenant. |
| `rejected` | `id_conflict` | A create collides with an existing row: its id belongs to a row the caller cannot see (e.g. another tenant's), a natural-key unique constraint (e.g. slug) matches a different row, or a concurrent writer won the race. Sync creates are strict inserts — the existing row is never adopted or overwritten. |
| `rejected` | `write_failed` | Unexpected error applying this item; the batch continued. Safe to retry. |

## Ordering

Items are applied **FIFO, strictly in request order**, one at a time. Later
items may depend on earlier items in the same batch (create a parent, then a
child). Clients replay their queues oldest-first; per-client ordering is the
client's responsibility (both target consumers are single-replayer by design —
multi-tab leader election on web, single-flight coalesced flush on mobile).

## Idempotency

**Replaying a batch is always safe.** Blind retries after ambiguous failures
(request sent, response lost) can never duplicate rows, resurrect deletes, or
double-apply effects. This is by construction, not by ledger:

1. **Row identity is the client UUID — and only the UUID.** Sync creates
   persist via a strict INSERT (`_insertOnly`): the natural-key dedup that
   `create()` performs elsewhere (#1472's ingestion-style upsert on
   slug/context or configured `conflictColumns`) does **not** apply, so a
   create can never adopt or rewrite a different row whose natural key
   happens to collide — it rejects with `id_conflict` instead. A re-delivered
   create finds its own row by id and reports `applied` as a no-op.
2. **No-op detection.** Before writing, each create/update is compared with
   the current row; if the row already reflects every payload field, nothing
   is written and the item reports `applied` with the row's existing
   `updatedAt`. Replays therefore cause **zero write amplification**: no
   `updated_at` churn, no phantom change-feed entries, no cache invalidation.
3. **Deletes are idempotent.** Deleting a row that is already gone reports
   `applied`, consistently, on every replay.

Guarantees, precisely:

- **State**: after any replay of an identical batch, database state is
  byte-identical to the state after the first application (given no
  interleaved foreign writes — an interleaved newer write is exactly what the
  conflict guard then reports).
- **Results**: per-item results (including `updatedAt` echoes) are identical
  across replays for **row-coherent batches** — at most one surviving
  mutation per row id, which is the shape both consumers emit after local
  coalescing. One documented edge: a batch that *creates and later deletes
  the same row* re-creates it transiently on replay, so that create's
  `updatedAt` echo is fresh each run (statuses, reasons, and final state
  remain identical). A batch that *creates then updates the same row* reports
  the replayed create as `conflict`/`create_conflict` from the second run
  (the row has moved past the create payload); the update itself replays as
  an `applied` no-op and state is unchanged. Coalescing clients never emit
  either shape; treat `applied` and `create_conflict` on a create replay both
  as "the row exists — mark the item synced".

## Conflict policy v1 (server-authoritative LWW)

Detection uses the **updated-at guard**: an `update`/`delete` carrying
`baseUpdatedAt` older than the server row's `updated_at` is a **stale write**
— the server row has changed since the client last saw it.

Resolution: **a losing (stale) write is skipped — the newer server state wins
— and the item reports `conflict`** with the server's current `updatedAt`.
The same policy applies to a create that lands on an existing, diverged row
(`create_conflict`).

The guard fires only when the mutation would actually change server state —
two idempotency rules deliberately take precedence over "stale ⇒ conflict":

- **No-op detection runs first.** A stale update whose payload already
  matches the row is a replay of a write that already landed (typically this
  very item, delivered earlier with the response lost) and reports `applied`.
  Clients must not assume a stale `baseUpdatedAt` unconditionally yields
  `conflict`.
- **Deletes of missing rows are no-ops.** A delete whose target is already
  gone reports `applied` regardless of `baseUpdatedAt`.

Why skip rather than apply the stale write:

1. *"Server-authoritative last-write-wins"* — by updated-at ordering, the
   server row **is** the last write; applying the older client write would be
   first-write-wins with data destruction.
2. **Nothing newer is ever silently destroyed.** A device that was offline
   for a week cannot clobber a week of newer edits by replaying blindly. The
   client is told (`conflict` + server `updatedAt`) and can re-fetch, rebase,
   and resubmit — or surface the conflict to the user.
3. **Replay stability.** A skipped conflict leaves state untouched, so
   replaying the same losing item reports the same `conflict` against the
   same state, keeping queue retries deterministic.

Omitting `baseUpdatedAt` opts the item out of conflict detection (the write
applies as a blind last-write). Field-level merge is explicitly out of scope
for v1 (see #1755).

## Authentication (fail-closed)

Every sync op is a mutation, so the fail-closed #1540 posture applies:

- **REST generator**: with an `authMiddleware` configured, it runs **per
  item** with the target's object name and the op's verb semantics
  (`create→post`, `update→put`, `delete→delete`); a 401 response rejects the
  item with `auth_required`, any other refusal with `forbidden`. Without
  middleware, only `@smrt({ api: { public: true } })` models apply —
  everything else rejects `auth_required` (`public: 'read'` does **not**
  unlock sync, mirroring CRUD).
- **SvelteKit route**: requires an authenticated principal on `locals`
  (`user` / `session` / `smrtAuth === true`, same resolution as generated
  CRUD routes); anonymous callers can only target `public: true` models.

## Tenant isolation

Every item flows through the standard collection stack, so the tenancy
interceptors guard sync exactly like CRUD:

- Rows outside the caller's tenant are invisible: cross-tenant updates reject
  with `not_found`, cross-tenant deletes are no-ops, and a create colliding
  with a foreign row's id rejects with `id_conflict` without touching it.
- Creates are stamped with the context tenant; a forged `tenantId` in the
  payload is stripped by the writable policy before it ever reaches the model.
- The generated SvelteKit route establishes tenant context from `locals`
  (same helper as generated CRUD routes) when any syncable model is
  tenant-scoped; REST hosts establish context however they already do for
  CRUD (e.g. the tenancy adapters).

## Mass-assignment guard (#1540)

Plain CRUD routes **still strip client-supplied ids** — nothing about that
changed (regression-tested). The sync contract is a *dedicated* path, not a
relaxation:

- Item payloads pass through the exact same writable policy as CRUD bodies:
  server-managed fields (`id`, `tenantId`, timestamps), `_`-prefixed keys,
  `@field({ readonly: true })` fields, and anything outside a configured
  `api.writable` allowlist are stripped.
- The row UUID is taken **only** from the validated envelope `id` field and
  injected after the policy runs. A payload `id` is dead on arrival.

## Consumer notes

**Web outbox (#1762)** — map per-item results onto TanStack offline
transaction completion: `applied` → transaction confirmed;
`conflict` → confirmed-with-notice (persist the returned `updatedAt`, refetch
the row, surface the conflict to app code); `rejected` with
`auth_required`/`forbidden` → pause the queue and re-authenticate; other
rejections → mark failed for app-level handling. `write_failed` is retryable.

**Mobile queue (#1739 / ADR 0001)** — mapping onto the
`pending → uploading → synced → failed` state machine:

| Apply result | Queue transition |
|---|---|
| HTTP 200, item `applied` or `conflict` | `uploading → synced` (conflicts additionally surface to the app with the server `updatedAt`) |
| HTTP 200, item `rejected` (`write_failed`) | `uploading → pending` (retry; counts an attempt toward `maxAttempts`) |
| HTTP 200, item `rejected` (any other reason) | `uploading → failed` (terminal — retrying an `invalid_id` or `forbidden` item cannot succeed) |
| HTTP 400 / network failure / response lost | whole batch `uploading → pending`; blind replay is safe by construction |

The item's queue-row UUID is the natural `itemId`; the entity UUID minted at
capture time is `id`. Crash recovery (`uploading → pending` on load) plus
this endpoint's idempotency yields exactly-once *effects* over at-least-once
delivery.

## Implementation map

| Piece | Location |
|---|---|
| Batch engine, envelope types, validation, conflict/no-op logic | `packages/core/src/sync/apply.ts` |
| REST route + host adapter | `packages/core/src/generators/rest.ts` (`handleSyncApply`) |
| Generated SvelteKit route | `packages/core/src/vite-plugin/sync-apply-route.ts` |
| Contract tests (replay, authz, UUIDs, conflicts, CRUD regression) | `packages/core/src/generators/sync-apply.spec.ts`, `packages/core/src/sync/apply.test.ts` |
| Tenant isolation tests | `packages/tenancy/src/__tests__/sync-apply-tenant-isolation.spec.ts` |
