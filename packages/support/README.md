# @happyvertical/smrt-support

AI-first, channel-neutral Support Cases for s-m-r-t. Chat messages and email can
create or join one tenant-scoped case, while the package owns lifecycle,
routing, service targets, escalation, human handoff, and auditable service time.

Support owns the client interaction and ticket. Delivery work remains in
[`@happyvertical/smrt-projects`](../projects/README.md); a support work link
connects the two without making Support execute repository work.

## Installation

```bash
pnpm add @happyvertical/smrt-support @happyvertical/smrt-timesheets
```

Add `svelte` for the optional operator surfaces. Support's `ServiceTimeEntry`
extends the [`smrt-timesheets`](../timesheets/README.md) entry (#3288). Under
pnpm, declare `@happyvertical/smrt-timesheets` directly: the CLI's manifest
discovery reads only top-level packages, so without it `smrt db:migrate` /
`db:status` stop planning the timesheets snapshot tables
(`service_charge_snapshots`, `service_compensation_snapshots`). Stored
`@happyvertical/smrt-projects:ServiceTimeEntry` references do not yet resolve
when smrt-support is installed, and neither does
`@happyvertical/smrt-timesheets:ServiceTimeEntry` (support's subtype replaces
it): reference `@happyvertical/smrt-support:ServiceTimeEntry`. See the
smrt-timesheets README migration note.

## Open and manage a case

Case-side models expose generated read operations, but writes go through service
facades so lifecycle and audit evidence cannot be bypassed:

```ts
import { SupportCaseService } from '@happyvertical/smrt-support';

const support = await SupportCaseService.create({ db: 'support.db' });
const supportCase = await support.openCase({
  tenantId: 'tenant-1',
  subject: 'Cannot publish the weekly edition',
  description: 'The publish action returns a validation error.',
  channelKind: 'chat',
  clientProfileId: 'profile-42',
  threadKey: 'chat:room-7:thread-12',
});

await support.recordInteraction(supportCase, {
  sourceKey: `manual:${crypto.randomUUID()}`,
  direction: 'internal',
  channelKind: 'api',
  actorKind: 'specialist',
  body: 'Reproduced and collecting validation details.',
});
```

Application schemas must be migrated before runtime; Support verifies its
tables and does not create them on demand.

## Case lifecycle

```text
new → triaged → assigned → in_progress
  → waiting_on_client | escalated
  → resolved → closed
```

Resolved cases may reopen with preserved history. Interactions and case events
form the complete handoff timeline. Transport `sourceKey` values make replayed
chat/email ingestion idempotent.

## Major services

| Service | Responsibility |
| --- | --- |
| `SupportCaseService` | Case writes, transitions, interactions, timeline, work links |
| `SupportIntakeService` | Bound chat/email create-or-join intake |
| `SupportAiWorkflow` | Acknowledge, classify, answer, troubleshoot, resolve |
| `HumanHandoffService` | Lossless context packaging and deduplicated handoff |
| `SupportRoutingService` | Explainable qualification, availability, and workload ranking |
| `ServiceTargetEngine` | Covered-time clocks and durable escalation jobs |
| `ServiceTimeEntryService` | One evidence contract for human and agent time |
| `TimeEntryApprovalService` | Approval plus client/provider commercial snapshots |
| `SupportPlanAdminService` | Permission-gated support and compensation plans |

The AI workflow fails toward a human. Client requests, low confidence, high
severity, sensitive categories, failed resolution, and policy limits always
remain handoff triggers.

When typed decisions are configured, the default classification boundary uses
the case plan's ordered severity definitions and evaluates sensitivity as a
predicate. `SupportPolicy.allowedCategories` is optional: supplying values
turns category into a closed decision vocabulary; leaving it empty preserves
free-category generation. A configured ambiguous severity/category stays
unassigned and hands off to a human; an exactly ambiguous sensitivity predicate
does so too. The recorded classification confidence is an operating aggregate for
audit only, never a calibrated answer confidence or the policy answer threshold.
App-injected `SupportAiBoundary` implementations remain authoritative.

## Commercial separation

Managed Support Plans define client coverage, targets, included time, and
overage pricing. Support Compensation Plans define provider earnings. Approved
time creates separate charge and compensation snapshots so margin remains
measurable and historical plan edits cannot rewrite evidence.

## Permissions

Importing the package registers these permission definitions:

- `support.reassign-case`
- `support.approve-time-entry`
- `support.manage-plans`

Privileged services accept a `SupportPrincipal` and reject cross-tenant
operations.

## Svelte entry point

`@happyvertical/smrt-support/svelte` exports presentational `CaseQueue`,
`CaseDetail`, `TargetList`, `RoutingRationale`, and
`TimeEntryApprovalQueue` components plus model-to-view adapters. Hosts own data
loading and actions. `TimeEntryApprovalQueue` lives in
[`smrt-timesheets`](../timesheets/README.md) and is re-exported here.

## Related packages

- [`smrt-chat`](../chat/README.md) and
  [`smrt-messages`](../messages/README.md) provide transports.
- [`smrt-jobs`](../jobs/README.md) runs escalation tasks.
- [`smrt-timesheets`](../timesheets/README.md) owns the shared time entry that
  support's `ServiceTimeEntry` extends with `caseId` / `specialistId`.
- [`smrt-users`](../users/README.md) supplies permission resolution.
- [`smrt-subscriptions`](../subscriptions/README.md) may supply plan keys without
  becoming a runtime dependency.

## Development

```bash
pnpm --filter @happyvertical/smrt-support test
pnpm --filter @happyvertical/smrt-support typecheck
pnpm --filter @happyvertical/smrt-support build
```

See [`AGENTS.md`](./AGENTS.md) for lifecycle, idempotency, timing, settlement,
and concurrency invariants.

## Decimal-hours-only shared evidence

The shared Timesheets service supports exact decimal-hours-only sources with
null `durationSeconds`; see [Timesheets](../timesheets/README.md#decimal-hours-only-sources).
The support entry subtype preserves this representation and its view displays
`durationHours()`. Support case-time recording and support-plan approval remain
seconds-based; approval rejects absent seconds before writing charges. Use the
shared `ServiceEvidenceService` with an hours-aware commercial resolver for
accepted decimal-hours evidence and its immutable commercial snapshots.
