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
   are removed before a descriptor or row crosses the tool boundary.
2. Mount a `DataSurfaceDescriptor` on `DataTable` (or a ContentList/report
   adapter) using the same identity, row key, version, schema version, and
   column capabilities. Human header interactions and registry commands must
   update the same controller snapshot.
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
