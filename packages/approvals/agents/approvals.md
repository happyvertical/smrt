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
3. Opens a transaction through core's `withEmbeddedWriteTransaction(db,
   isEmbeddedDatabase(db), fn)`. On embedded engines (SQLite, DuckDB, libsql)
   it takes the embedded write queue for the database first, then the
   adapter's connection lock; the event insert and change-feed append inside
   re-enter that hold. The reverse order (a raw `db.transaction()`) deadlocks
   against an unrelated NULL-tenant save, which holds the queue and then
   opens its own write transaction, until the 30 s transaction-queue timeout,
   and lets other root writes land inside the transaction. The queue also
   serializes transitions per database, so no separate chain exists.
   PostgreSQL is not queued: each transaction gets its own pooled connection.
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
On embedded engines that handle must come from `withEmbeddedWriteTransaction`
or `SmrtObject.withTransaction()`, never a raw `db.transaction()`, for the
lock-order reason in step 3.

## Raw SQL boundaries

The guarded UPDATEs are the only raw SQL. They bind every value (no literal
UUIDs or empty strings), validate the request id as a UUID first, and name
`tenant_id`. Reads and inserts go through collections so tenancy
interceptors, UUID columns, and the change feed behave as for any model.

## Service-only write capability

Only `ApprovalService` inserts `ApprovalRequest` and `ApprovalEvent` rows
(events only in the same transaction as the guarded UPDATE they record). It passes the
module-private `SERVICE_WRITE` symbol (`src/write-capability.ts`, not a public
export) as a constructor option; the model records that instance in a
`WeakSet` and refuses, in `save()` and `validateBeforeSave()`, any insert
without it, and any minted insert that does not start pending, undecided,
and unconsumed. `new ApprovalRequest({ status: 'approved' }).save()`,
`ApprovalRequestCollection.create(...)`, and a forged `approved` event
(which would otherwise count toward quorum) are refused and write nothing. A
symbol never arrives from JSON, so REST and MCP input cannot carry it (the
smrt-reports `runtime-report.ts` pattern). It guards the in-process API,
not raw SQL.

`consume` re-checks the ledger before consuming (defence in depth against a
status written around the service): the `created` event at sequence 1, no
terminal event, and `approved` events from at least `requiredApprovals`
distinct human actors; requester events count only with `selfApproved: true`
and a valid `selfApprovalPermission` audit slug. Otherwise it refuses
`unbacked_approval`. Quorum counting in `decide` applies the same filter.

## Edit-then-approve (#5141)

A kind opts in with `allowRevisedApproval: true` (default false: the decider
would approve content they changed). `decide({ decision: 'approve',
revisedSubjectRevisionHash })` rebinds the request to the revised hash in the
same guarded UPDATE (`subject_revision_hash` is in the predicate and the SET),
and the `approved` event records the revised hash; the `created` event keeps
the requested one, so the ledger shows both. Refusals: `revision_not_allowed`
(kind did not opt in), `revision_after_approval` (any `approved` event exists:
earlier approvers saw other content). Any decision may pass
`expectedSubjectRevisionHash`; a mismatch is refused `revision_mismatch`, so a
decision never lands on content the decider did not review. On a kind with
`allowRevisedApproval`, an `approve` without it throws `APPROVAL_INVALID`
(the revision can move under a decider); the mail gate also refuses an empty
`expectedBindingHash`, and its approver list excludes the requester's own
votes exactly as quorum counting does. Quorum counting
(`decide` and `consume`'s ledger check) counts only `approved` events whose
hash equals the bound revision. No schema change.

## Mail-send gate (#5141)

`createApprovalMailSendGate({ service })` (`src/mail-send-gate.ts`) satisfies
smrt-messages' structural `MailSendApprovalGate`; neither package imports the
other. Kind `messages.mail.send`, subject `@happyvertical/smrt-messages:Message`,
permission `messages.send`, `allowRevisedApproval: true`, `requestKey`
`mail-send:<messageId>:<bindingHash>` with the mcp-gate epoch suffix. The
requester holds no permission; a decider is `human` only when labelled
`person` or `human`. `check` only reports state and never consumes, so the
requester can never release its own send; an approving person releases it
through `consume`, which first hands the counted approvers of the bound
revision to the caller's `verifyApprovers` (smrt-messages checks each still
holds `send` on the account); false refuses `approver_not_authorized` and
leaves the approval unconsumed.

## Out of scope here (later slices of #3716)

- Slice 2: Svelte inbox, panel, decision bar; `approvals.requests` recipe.
- Slice 3: notification adapter (`UserNotificationService.notify`, sourceRef
  `approval:<id>:<event>`), profiles `AuditLog` mirror, expiry and reminder
  job calling `expireDue`.
- Slice 4: adopters (social, personas, content, subscriptions).
- Slice 5 (shipped, #5087): `createApprovalMcpGate` (`src/mcp-gate.ts`) for
  app-mcp `confirmTools`; kind `mcp.tool.call`, subject id the tool name,
  revision hash the call binding, `requestKey` `mcp:<binding>`. The caller is
  mapped to a permissionless principal; unknown principal kinds are `agent`.
  The snapshot lives in the readonly `summary` (no schema change; a dedicated context column would need a migration); a request in `changes_requested` is refused (rejected too); a consumed or expired binding opens a new request under key `<key>:<epoch>`. The dependency edge is dev-only (app-mcp does not import approvals); keep it
  that way so the graph stays acyclic.
- Slice 6: #3667 `pending_approval` hand-off.

Known gaps: listing every holder of a permission needs a users-package
helper (for notifications); a vote stays counted if the approver later loses
the permission.

## Permission-gated self-decisions

A kind may opt in with `selfApprovalPermission: 'content.approve-self'`.
The requester must be human and hold that permission plus every normal snapshot,
current kind and tenant-policy decision permission. All three verdicts use this
allowance. Without the opt-in or grant, `self_approval` remains the refusal.
Self-decisions record `selfApproved` and `selfApprovalPermission` on the event;
ordinary events default to false and an empty slug. These fields are service-only,
not caller input. Deploy the generated event-column migration before upgrading
runtime code; existing events default to false/empty and cannot gain self authority.
Like other votes, an authorized self vote remains counted after permission or kind
configuration changes. It counts once, never bypasses quorum, expiry or tenancy,
and remains atomic with the guarded transition.

DuckDB deployments on `@happyvertical/sql` 0.103.1 may repeatedly recreate the
unchanged request/sequence index during migration because index introspection
retains SQL identifier quotes; see [SDK #1395](https://github.com/happyvertical/sdk/issues/1395).
The new audit columns converge and existing ordinary approvals remain consumable.
