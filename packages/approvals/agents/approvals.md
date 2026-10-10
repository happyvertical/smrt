# Approvals: transitions, concurrency, and scope

Design source: the accepted recommendation on smrt#3716. This file records
the slice-1 contract (#3741) and what later slices add.

## States and transitions

```
pending --approve (distinct approvers reach quorum)--> approved
approved --consume (hash matches, unexpired)---------> approved + consumedAt
pending --reject | request_changes-------------------> rejected | changes_requested
pending --cancel (requester or approvals.cancel-any)-> cancelled
pending | approved(unconsumed) --expire (deadline)---> expired
```

`changes_requested` is terminal in slice 1: the requester opens a new request
for the new revision (a new `subjectRevisionHash`). There is no resubmit.

Each transition in `src/service.ts`:

1. Validates input and the principal (`id`, UUID `tenantId`, `type`, `can`).
2. Refuses a principal whose tenant differs from an active tenant context.
3. Opens a transaction (serialized per database on SQLite and DuckDB, which
   multiplex every transaction over one connection; PostgreSQL uses its
   pooled per-transaction connection).
4. Reads the request through a transaction-bound collection with an explicit
   `tenantId` filter, and classifies refusals from that read.
5. Runs the guarded UPDATE with the version it read. Zero rows: the
   transaction body returns `retry`, nothing was written, and the loop starts
   again from a fresh read (up to `maxAttempts`, then `contention`).
6. Inserts the event with `sequence` = the returned version and appends a
   change-feed entry (the raw UPDATE bypasses save hooks).
7. Re-reads the request after commit on the service connection.

On PostgreSQL the UPDATE takes the row lock; under READ COMMITTED a waiting
UPDATE re-evaluates `version = ?` after the winner commits, so it matches
nothing. Unique keys `(request_id, sequence)` and `(request_id, vote_key)`
are a second line: a violation aborts the attempt and it retries.

`consume({ transaction })` runs steps 4 to 6 on the caller's open
transaction, once, without retry or serialization; the caller owns commit.

## Raw SQL boundaries

The guarded UPDATEs are the only raw SQL. They bind every value (no literal
UUIDs or empty strings), validate the request id as a UUID first, and name
`tenant_id`. Reads and inserts go through collections so tenancy
interceptors, UUID columns, and the change feed behave as for any model.

## Out of scope here (later slices of #3716)

- Slice 2: Svelte inbox, panel, decision bar; `approvals.requests` recipe.
- Slice 3: notification adapter (`UserNotificationService.notify`, sourceRef
  `approval:<id>:<event>`), profiles `AuditLog` mirror, expiry and reminder
  job calling `expireDue`.
- Slice 4: adopters (social, personas, content, subscriptions).
- Slice 5: agent and MCP request tools (deciding stays human-only).
- Slice 6: #3667 `pending_approval` hand-off.

Known gaps: listing every holder of a permission needs a users-package
helper (for notifications); a vote stays counted if the approver later loses
the permission.
