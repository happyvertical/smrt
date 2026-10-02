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

The entry and both snapshots expose generated `list` / `get` on REST, CLI,
and MCP, with optional tenant scoping. An application that routes all time
and money through its own permission-gated services declares a same-named
subclass over each table and closes it:

```ts
import {
  ServiceChargeSnapshot as SharedServiceChargeSnapshot,
  ServiceCompensationSnapshot as SharedServiceCompensationSnapshot,
  ServiceTimeEntry as SharedServiceTimeEntry,
} from '@happyvertical/smrt-timesheets';

const CLOSED = { include: [] };

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'service_time_entries',
  api: CLOSED,
  cli: CLOSED,
  mcp: CLOSED,
})
export class ServiceTimeEntry extends SharedServiceTimeEntry {
  // restate the fields — see AGENTS.md
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'service_charge_snapshots',
  conflictColumns: ['time_entry_id'],
  api: CLOSED,
  cli: CLOSED,
  mcp: CLOSED,
})
export class ServiceChargeSnapshot extends SharedServiceChargeSnapshot {
  // restate the fields — see AGENTS.md
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'service_compensation_snapshots',
  conflictColumns: ['time_entry_id'],
  api: CLOSED,
  cli: CLOSED,
  mcp: CLOSED,
})
export class ServiceCompensationSnapshot extends SharedServiceCompensationSnapshot {
  // restate the fields — see AGENTS.md
}
```

Do not copy `previousQualifiedNames` into these subclasses: an old name may
have only one claimant. Replacing the timesheets classes drops their
smrt-projects aliases (see the known gap under "Stored and declared class
names").

Restate `conflictColumns` exactly as shown unless you mean to change it. The
snapshots' conflict key is `time_entry_id` alone — one snapshot per entry —
and, being an explicit key, it is never rewritten to lead with `tenant_id`
when you require tenancy. That is safe as long as entry ids are unique across
tenants (they are UUIDs). Widening it to `['tenant_id', 'time_entry_id']` is
your decision, and it is a schema change for your database (a new unique
index replacing `service_*_snapshots_time_entry_id_idx`), so it goes through
`smrt db:migrate` like any other key change; the package default stays
`['time_entry_id']`.

## Migrating from smrt-projects / smrt-support

`ServiceTimeEntry`, its collection, `ServiceChargeSnapshot`,
`ServiceCompensationSnapshot`, their collections, and
`ServiceEvidenceService` moved here in #3288.

**Consumers already holding `service_time_entries` rows need no schema change
and no data migration.** The table names, columns, indexes, and conflict keys
are unchanged, and the tables carry no type discriminator, so existing rows
load through every package's classes as they are. References stored under
the old smrt-projects class names keep resolving as deprecated aliases (see
"Stored and declared class names" below; one gap applies with smrt-support).

> **pnpm: add a direct `@happyvertical/smrt-timesheets` dependency.** The
> CLI's manifest discovery (`smrt db:migrate`, `db:status`, `db:diff`) reads
> only packages installed at the top level of `node_modules`. Under pnpm a
> transitive dependency is not there, so an application that depends on
> smrt-projects or smrt-support but not on smrt-timesheets stops planning
> `service_time_entries`, `service_charge_snapshots`, and
> `service_compensation_snapshots`: a fresh database never gets them (and
> `ServiceEvidenceService` then fails the runtime table check), and an
> existing one reports them as orphan tables. Add
> `pnpm add @happyvertical/smrt-timesheets`. npm and Yarn hoist the package
> and are unaffected.

| Before | After |
|---|---|
| `@happyvertical/smrt-projects` / `@happyvertical/smrt-support` in `dependencies` | Also add `@happyvertical/smrt-timesheets` under pnpm, or the CLI stops planning the three time tables (see the note above) |
| `ServiceTimeEntry`, `ServiceEvidenceService`, snapshots from `@happyvertical/smrt-projects` | Same names, still exported from smrt-projects (re-exports); new code imports `@happyvertical/smrt-timesheets` |
| `ServiceTimeEntry` from `@happyvertical/smrt-support` | Unchanged: support's subtype, now extending the timesheets entry |
| `caseId` / `specialistId`, `forCase()` / `forSpecialist()` on the projects export | Support subtype only — import `ServiceTimeEntry` / `ServiceTimeEntryCollection` from smrt-support |
| `ServiceEvidenceService.record({ caseId })` | Requires `workRefType` + `workRefId`; record case time through smrt-support's `ServiceTimeEntryService` |
| `@happyvertical/smrt-projects:ServiceTimeEntry` (and the two snapshot names) stored in `meta_type` or declared in `@crossPackageRef` / playbook `model:` | Resolves as a deprecated alias of `@happyvertical/smrt-timesheets:*`; move declarations to the new name, optionally backfill stored rows with `smrt db:migrate-qualified-names` (see below) |
| `TimeEntryList`, `TimeEntryCard`, `TimeSummary`, `DurationDisplay` from `@happyvertical/smrt-projects/svelte`; `TimeEntryApprovalQueue` from `@happyvertical/smrt-support/svelte` | Still exported there; canonical home `@happyvertical/smrt-timesheets/svelte` |

An application with smrt-projects but not smrt-support keeps its existing
`case_id` / `specialist_id` columns: `db:migrate` reports them as orphan
columns and never alters or drops them, and saves through the shared entry
leave their values untouched.

### Stored and declared class names

The moved models' registered names changed from
`@happyvertical/smrt-projects:*` to `@happyvertical/smrt-timesheets:*`. Each
class declares its old name in `previousQualifiedNames` (#3338), so references
that stored or declared it keep resolving as a **deprecated alias**:
polymorphic association rows (`metaType`, including smrt-assets
`AssetAssociation`), `ObjectRegistry.getClassByQualifiedName()`,
`@crossPackageRef` and relationship targets, and playbook step `model:`
names. The first resolution of each old name per process logs a deprecation
warning; new association writes store the current name. Generated routes,
MCP tool names, and permission slugs derive from simple and collection names
and are unchanged.

- `smrt doctor --db` counts stored references that still use an old name
  ("Deprecated Qualified Names").
- `smrt db:migrate-qualified-names` is an opt-in backfill that rewrites them
  to the current names (`--dry-run` first); it is never run automatically.
- Move source references — `@crossPackageRef(...)`, relationship targets,
  playbook `model:` names — to `@happyvertical/smrt-timesheets:*` now. The
  aliases will be removed in a later **breaking** release, once `smrt doctor
  --db` reports no stored references.

> **Known gap: same-named subtypes drop the alias.** A same-named subclass
> over a moved table — smrt-support's `ServiceTimeEntry`, or an
> application's closing subclass (see "Closing the generated surface") —
> replaces the timesheets class in the registry, and that class's alias does
> not carry over to it yet. With smrt-support installed,
> `@happyvertical/smrt-projects:ServiceTimeEntry` therefore does not resolve
> (hydration returns `null`) and `smrt doctor --db` /
> `db:migrate-qualified-names` do not see it; the snapshot aliases still work
> unless the application subclasses the snapshots too. A subclass must not
> redeclare the alias (two claimants of one old name collide). Until core
> carries aliases across the replacement, rewrite affected stored references
> (typically `meta_type` columns) to the replacing class's current name, e.g.
> `@happyvertical/smrt-support:ServiceTimeEntry`.

## Related packages

- [`smrt-projects`](../projects/README.md) — delivery work and
  `SubscriptionServiceCommercialResolver` pricing for these entries.
- [`smrt-support`](../support/README.md) — support-case time on the same table.
- [`smrt-profiles`](../profiles/README.md) — the participants.
