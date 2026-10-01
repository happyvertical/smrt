# @happyvertical/smrt-timesheets

Shared time entries for s-m-r-t: who worked how long on what, whether someone
approved it, and what it was charged and paid at approval. One model for
professional services, shop floors, and job sites, instead of one per vertical.

- **Who** — a `smrt-profiles` Profile (`participantKind: 'human'`) or an agent
  (`participantKind: 'agent'`, `agentRef`).
- **What** — a generic work reference: `workRefType` (a qualified class name)
  and `workRefId`. No domain-specific foreign key on the base entry.
- **How long** — `startedAt`, `endedAt`, `durationSeconds`, and the `source`
  (`timer`, `manual`, `import`, `agent`).
- **Approval** — `draft → submitted → approved | rejected`; approved entries
  never change. A correction is a new row whose `correctionOfId` points at the
  entry it corrects, which flips to `corrected`.
- **Money** — never on the entry. Approval writes one immutable
  `ServiceChargeSnapshot` and one `ServiceCompensationSnapshot`, in integer
  minor units (`$19.99` is `1999`), consistent with
  [`smrt-commerce`](../commerce/README.md).

See [AGENTS.md](./AGENTS.md) for invariants and extension rules.

## Installation

```bash
pnpm add @happyvertical/smrt-timesheets
```

Add `svelte` for the optional UI components. Application schemas are created
by migrations (`smrt db:migrate`); the package never creates tables at
runtime.

## Record, approve, and correct time

```ts
import { ServiceEvidenceService } from '@happyvertical/smrt-timesheets';

const timesheets = await ServiceEvidenceService.create({ db }, {
  // Your pricing and pay rules; amounts are integer minor units.
  priceClient: async (entry) => ({
    amount: Math.round(entry.durationHours() * 9500),
    version: 'rates-2026',
    terms: { hourlyRate: 9500 },
  }),
  compensateProvider: async (entry) => ({
    amount: Math.round(entry.durationHours() * 6000),
    version: 'pay-2026',
    terms: { hourlyRate: 6000 },
  }),
});

const entry = await timesheets.record({
  workRefType: '@acme/jobs:WorkPackage',
  workRefId: 'wp-7',
  participantKind: 'human',
  participantProfileId: profile.id,
  source: 'timer',
  description: 'Framed the north wall',
  startedAt: new Date('2026-07-01T08:00:00Z'),
  endedAt: new Date('2026-07-01T10:30:00Z'),
});

await timesheets.submit(entry, profile.id);
await timesheets.approve(entry, { approvalPath: 'operator' });
```

`record()` rejects a missing or half work reference, a human entry without a
Profile, an agent entry without `agentRef`, a reversed period, and a
non-positive duration. `correct(entry, input)` records the replacement and
marks the approved entry `corrected`.

## Svelte components

```svelte
<script lang="ts">
  import { TimeEntryList, TimeSummary } from '@happyvertical/smrt-timesheets/svelte';
</script>

<TimeSummary totalHours={12.5} totalAmount={118750} currency="CAD" />
<TimeEntryList {entries} selectable />
```

`TimeEntryCard`, `TimeEntryList`, `TimeSummary`, `DurationDisplay`, and
`TimeEntryApprovalQueue` are props-driven: hosts load entries and pass plain
view objects (`TimeEntry`, `TimeEntryApprovalView`).

## Closing the generated surface

The base entry exposes generated `list` / `get` on REST, CLI, and MCP. An
application that routes all time through its own permission-gated services
declares a same-named subclass over the same table and closes it:

```ts
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'service_time_entries',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class ServiceTimeEntry extends SharedServiceTimeEntry {
  // restate the fields — see AGENTS.md
}
```

## Migrating from smrt-projects / smrt-support

`ServiceTimeEntry`, its collection, `ServiceChargeSnapshot`,
`ServiceCompensationSnapshot`, their collections, and
`ServiceEvidenceService` moved here in #3288.

**Consumers already holding `service_time_entries` rows need no schema change
and no data migration.** The table names, columns, indexes, and conflict keys
are unchanged, and the tables carry no type discriminator, so existing rows
load through every package's classes as they are.

| Before | After |
|---|---|
| `ServiceTimeEntry`, `ServiceEvidenceService`, snapshots from `@happyvertical/smrt-projects` | Same names, still exported from smrt-projects (re-exports); new code imports `@happyvertical/smrt-timesheets` |
| `ServiceTimeEntry` from `@happyvertical/smrt-support` | Unchanged: support's subtype, now extending the timesheets entry |
| `caseId` / `specialistId`, `forCase()` / `forSpecialist()` on the projects export | Support subtype only — import `ServiceTimeEntry` / `ServiceTimeEntryCollection` from smrt-support |
| `ServiceEvidenceService.record({ caseId })` | Requires `workRefType` + `workRefId`; record case time through smrt-support's `ServiceTimeEntryService` |
| `TimeEntryList`, `TimeEntryCard`, `TimeSummary`, `DurationDisplay` from `@happyvertical/smrt-projects/svelte`; `TimeEntryApprovalQueue` from `@happyvertical/smrt-support/svelte` | Still exported there; canonical home `@happyvertical/smrt-timesheets/svelte` |

An application with smrt-projects but not smrt-support keeps its existing
`case_id` / `specialist_id` columns: `db:migrate` reports them as orphan
columns and never alters or drops them, and saves through the shared entry
leave their values untouched. The registered class names for the moved models
are now `@happyvertical/smrt-timesheets:*`; generated routes and MCP tool names
derive from the simple names and are unchanged.

## Related packages

- [`smrt-projects`](../projects/README.md) — delivery work and
  `SubscriptionServiceCommercialResolver` pricing for these entries.
- [`smrt-support`](../support/README.md) — support-case time on the same table.
- [`smrt-profiles`](../profiles/README.md) — the participants.
