# @happyvertical/smrt-approvals

A small decision gate for s-m-r-t applications. A package defines an approval
kind; a requester opens a request bound to one revision of one subject;
eligible people decide; the consumer consumes the approval exactly once and
then performs its own action. It is not a workflow engine: there are no
stages, no executor, and no compensation.

## Install

```bash
pnpm add @happyvertical/smrt-approvals
```

## Concepts

| Model | Purpose |
| --- | --- |
| `ApprovalRequest` | One gate on one subject revision: kind, subject type and id, revision hash, requester, status, quorum, expiry, decision and consumption timestamps, tenant. |
| `ApprovalEvent` | Append-only ledger: `created`, `approved`, `rejected`, `changes_requested`, `cancelled`, `expired`, `consumed`, with actor and reason. The source of truth. |
| `ApprovalPolicy` | A tenant's tightening of a kind: a higher quorum, a shorter expiry, or one more required permission. It can never loosen the package defaults. |

Status moves from `pending` to `approved`, `rejected`, `changes_requested`,
`cancelled`, or `expired`. An approved request is consumed once (it keeps the
`approved` status and gains `consumedAt`) or expires unconsumed. A request
that needs changes is finished; the requester opens a new request for the new
revision.

## Usage

```typescript
import {
  ApprovalService,
  defineApprovalKind,
} from '@happyvertical/smrt-approvals';

// In the owning package. Register `social.approve-post` with
// registerPermissionDefinitions from @happyvertical/smrt-users.
export const publishPost = defineApprovalKind({
  key: 'social.post.publish',
  subject: '@happyvertical/smrt-social:SocialPost',
  permission: 'social.approve-post',
  defaults: { requiredApprovals: 1, ttlMs: 7 * 24 * 60 * 60 * 1000 },
});

const approvals = new ApprovalService({ db });

// Any principal type may request: human, agent, or service.
const opened = await approvals.requestApproval(author, {
  kind: publishPost,
  subjectId: post.id,
  subjectRevisionHash: revisionHash(post),
  requestKey: `publish:${post.id}:${revisionHash(post)}`,
});

// Only a human of the same tenant, other than the requester, holding the
// kind's permission, may decide, once.
await approvals.decide(editor, opened.request.id, { decision: 'approve' });

// The consumer presents the revision it is about to act on.
const used = await approvals.consume(publisher, opened.request.id, revisionHash(post));
if (used.outcome === 'transitioned') {
  await publish(post);
}
```

A principal is `{ id, tenantId, type: 'human' | 'agent' | 'service', can(slug) }`,
built from `PermissionResolver.resolvePermissions(userId, tenantId)` in
production or `approvalPrincipalFromPermissions()` in tests.

Every transition returns `{ outcome, request, refusal? }`. `outcome` is
`transitioned`, `already_applied` (an idempotent `requestKey` replay), or
`refused` with a typed reason such as `not_pending`, `expired`,
`self_approval`, `not_human`, `forbidden`, `already_decided`,
`revision_mismatch`, `already_consumed`, `unbacked_approval`, or `not_found`. A refusal writes
nothing.

To consume inside your own transaction, so the domain write and the
consumption commit together, pass `{ transaction: tx }` to `consume`. On
SQLite and DuckDB open that transaction with `withEmbeddedWriteTransaction`
from `@happyvertical/smrt-core` (or `SmrtObject.withTransaction()`), not a raw
`db.transaction()`, so it holds the embedded write queue.

Expiry: `expire(principal, id)` and `expireDue(principal)` record expiry for
requests whose deadline passed; a job can call them. Decisions and
consumption after the deadline are refused even before the sweep runs.

## Guarantees

- Every transition is one guarded conditional `UPDATE` (id, tenant, expected
  status, version, expiry) plus one event insert in the same transaction.
  Concurrent double approval or double consumption has exactly one winner;
  the loser is refused cleanly and writes nothing.
- Quorum counts distinct approvers from the ledger; one actor decides once.
- Tenant isolation on every read and write: a request id from another tenant
  is `not_found`.
- The generated REST and MCP surface is `list` and `get` only, and there is no
  generated CLI. Events cannot be updated or deleted.
- Only `ApprovalService` can create requests: a request built directly
  (`new ApprovalRequest(...)`, `ApprovalRequestCollection.create(...)`) is
  refused at the model layer. `consume` also refuses an approval its event
  ledger does not back (`unbacked_approval`).

## Permissions

| Slug | Grants |
| --- | --- |
| per-kind slug | Deciding requests of that kind. |
| `approvals.cancel-any` | Cancelling someone else's pending request. |
| `approvals.manage-policy` | Writing tenant policy (humans only). |

## Development

```bash
pnpm --filter @happyvertical/smrt-approvals test
pnpm --filter @happyvertical/smrt-approvals typecheck
pnpm --filter @happyvertical/smrt-approvals test:postgres
```

See [AGENTS.md](./AGENTS.md) and [agents/approvals.md](./agents/approvals.md)
for the design invariants.

## License

MIT
