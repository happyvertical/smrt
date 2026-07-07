# Mobile Multipart Upload Contract

Status: shipped (issue #1748, ADR 0001 Phase 3.5)
Owners: `@happyvertical/smrt-users` (server), `@happyvertical/smrt-mobile` (client)

The `/api/mobile` surface has two write paths:

1. **Framework-model writes** ride the batch [`sync/apply` contract](./sync-apply-contract.md).
   Idempotency is by construction (`itemId` + `baseUpdatedAt`); there is no
   `Idempotency-Key` header in that contract, and per-item results arrive
   inside HTTP 200.
2. **Media/evidence uploads** are hand-written, app-owned multipart routes.
   This document is their contract. Domain ingestion (what a capture *is*,
   validation rules, storage) deliberately stays app-side — SMRT ships the
   auth guard, the dedup-key convention, and the client.

## Wire shape

The shared KMP client (`MobileApiClient.submitMultipart`, Phase 4) sends:

- `POST` `multipart/form-data` to an app-chosen route under the app's mobile
  base path (e.g. `/api/mobile/captures`). Avoid the reserved sibling
  segments `sync`, `_events`, and `_changes`.
- `Authorization: Bearer <token>` — the mobile session token issued by
  `auth/complete` (see `createMobileAuthHandlers`).
- Plain string fields first, then one part per file with `fieldName`,
  `filename`, and an explicit `Content-Type` per part.
- `Idempotency-Key: <queue entry id>` when the upload is re-sent by the
  durable write queue.

## Dedup semantics (`clientCaptureId` / `Idempotency-Key`)

Retries are NORMAL: the mobile queue re-POSTs after dropped connections and
process death, so an upload route without dedup will double-ingest.

- The **`clientCaptureId` form field is the primary dedup key** — a
  client-generated identifier for the capture itself (stable across queue
  re-enqueues).
- The **`Idempotency-Key` header is the fallback** when the field is absent
  (the shared client stamps it with the durable queue entry's id). The field
  wins when both are present.
- `resolveMobileUploadDedupKey(formData, request.headers)` from
  `@happyvertical/smrt-users/sveltekit` implements exactly this precedence.
- On a dedup hit the server must return the ORIGINAL success payload (e.g.
  the existing record's id) with a 2xx status — without re-uploading media
  or creating a second row. A replay is a success, not a conflict.
- Scope dedup lookups to the authenticated user (a key is client-generated
  and must never collide across users).
- Uploads without either key have no dedup guarantee; whether to accept
  them is app policy.

## Status-code contract (what the client's queue does with your response)

`HttpQueueSender` maps HTTP outcomes to queue semantics for these
single-item endpoints, so status codes are behavior, not decoration:

| Response | Client behavior |
| --- | --- |
| 2xx | Entry completes (dedup replays included). |
| 401 | Flush aborts, stored session is cleared, user re-authenticates; the queue KEEPS its entries. Use only for auth failures. |
| 408, 429 | Retryable — entry stays pending. |
| Other 4xx | PERMANENT failure — the entry will not be retried. Use for validation rejections (bad mime, oversize, unknown target). |
| 5xx | Retryable server fault — entry stays pending. |

Error bodies are JSON: `{ "error": string, "code"?: string }` — the shape
every `createMobileAuthHandlers` endpoint already emits.

## Server-side pattern

```ts
import { assertOperationPermission } from '@happyvertical/smrt-users';
import {
  createMobileAuthHandlers,
  resolveMobileUploadDedupKey,
} from '@happyvertical/smrt-users/sveltekit';

const mobile = createMobileAuthHandlers({ db, providers, redirectUris });

// routes/api/mobile/captures/+server.ts
export const POST = mobile.guard(async (event, ctx) => {
  await assertOperationPermission({ db, collection: 'captures', action: 'create' });

  const formData = await event.request.formData(); // buffers the WHOLE body
  const dedupKey = resolveMobileUploadDedupKey(formData, event.request.headers);
  if (dedupKey) {
    const existing = await findCaptureByClientKey(ctx.userId, dedupKey);
    if (existing) return json({ id: existing.id }); // replay → original result
  }

  // Validate every part BEFORE storing anything (mime sniffing, per-part and
  // total size caps), then ingest and persist dedupKey alongside the record.
});
```

The guard (`mobile.guard` / `mobile.withSession`) resolves the bearer
session, enters the request permission context (so `assertOperationPermission`
and tenancy interceptors see the caller), and populates `event.locals`. Any
model JSON you return must pass the session's resolved permissions through
`toPublicJSON({ permissions: ctx.permissions })` — read-permission redaction
is fail-closed (#1822).

## Operational limits

- `request.formData()` buffers the entire multipart body in memory before
  the handler runs. On adapter-node, `BODY_SIZE_LIMIT` (default 512 KB)
  rejects larger bodies with an opaque 413 BEFORE your handler executes —
  deployments must raise it to at least the app's max upload size, and that
  size should stay modest precisely because of the buffering.
- The Phase-4 client buffers each part as a `ByteArray` (photo-scale).
  Streamed multipart is tracked in #1871 — do not size this contract for
  video until it lands.
