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
and money through its own permission-gated services can close those surfaces
without declaring replacement models:

```ts
import { ObjectRegistry } from '@happyvertical/smrt-core';
import '@happyvertical/smrt-timesheets';

for (const name of [
  'ServiceTimeEntry',
  'ServiceChargeSnapshot',
  'ServiceCompensationSnapshot',
]) {
  ObjectRegistry.registerOverride(`@happyvertical/smrt-timesheets:${name}`, {
    api: false,
    cli: false,
    mcp: false,
    tenancy: { mode: 'required' },
  });
}
```

Register overrides after importing the models and before constructing or
emitting generated transports. Use the currently registered qualified name:
when smrt-support has replaced `ServiceTimeEntry`, target
`@happyvertical/smrt-support:ServiceTimeEntry` instead. Overrides accept only
closed surfaces and required tenancy; they cannot reopen a surface or weaken
tenancy. They survive registration replay and are reset by
`ObjectRegistry.clear()`. Existing static route files must be regenerated with
the closed configuration; changing the registry does not rewrite deployed files.

This preserves the model's fields, indexes, conflict keys, and aliases. Same-named
subclasses remain available when an application needs to change the model itself;
see AGENTS.md for field restatement and the alias gap below.

The snapshots' conflict key remains `time_entry_id` alone — one snapshot per
entry — and is never rewritten to lead with `tenant_id` when tenancy becomes
required. Entry ids are UUIDs unique across tenants. Widening that key to
`['tenant_id', 'time_entry_id']` is a consumer schema change requiring a new
unique index through `smrt db:migrate`; runtime overrides do not change schema.

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
| `@happyvertical/smrt-projects:ServiceTimeEntry` (and the two snapshot names) stored in `meta_type` or declared in `@crossPackageRef` / playbook `model:` | Resolves as a deprecated alias of `@happyvertical/smrt-timesheets:*`; move declarations to the class that is registered in your app — `@happyvertical/smrt-timesheets:*`, except `@happyvertical/smrt-support:ServiceTimeEntry` when smrt-support is installed (or your own closing subclass) — and optionally backfill stored rows with `smrt db:migrate-qualified-names` (see below) |
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
  playbook `model:` names — to the name of the class your application
  actually registers, now. That is `@happyvertical/smrt-timesheets:*`, except
  where a same-named subclass replaces the timesheets class: with smrt-support
  installed, reference `@happyvertical/smrt-support:ServiceTimeEntry` (the
  timesheets name is not registered there, so a `@crossPackageRef` to it
  fails to load and an association stored under it hydrates to `null`); with
  your own closing subclass, reference your subclass's qualified name. The
  snapshots keep their timesheets names unless you subclass them. The aliases
  will be removed in a later **breaking** release, once `smrt doctor --db`
  reports no stored references.

> **Known gap: same-named subtypes drop the alias.** A same-named subclass
> over a moved table — smrt-support's `ServiceTimeEntry`, or an
> application's replacement subclass —
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

## Attendance

The `@happyvertical/smrt-timesheets/attendance` subpath adds `AttendancePunch`,
`AttendanceBreak`, and `AttendanceService`. Apply migrations for the new tables
before enabling the module. Existing entry and snapshot tables are unchanged.
Attendance supports SQLite and PostgreSQL. DuckDB cannot enforce the required
`ON UPDATE CASCADE` foreign-key contract used by attendance and existing entry
corrections; schema creation deliberately fails rather than omitting constraints.

Construct a service with your database and the **authorized session's**
`{ tenantId, profileId }`. The application resolves Profile membership and
operation permissions before this boundary; never pass request-supplied actor
identifiers. A conflicting active tenant is refused. The service cannot read or
link another profile's punch. Generated punch/break surfaces default to reads
only; the replay ledger has no generated operations and is excluded from change
feeds. Before constructing generated transports, consumers can close the remaining
reads without replacing the models or changing their schema:

```ts
import { ObjectRegistry } from '@happyvertical/smrt-core';
import '@happyvertical/smrt-timesheets/attendance';

for (const model of ['AttendancePunch', 'AttendanceBreak']) {
  ObjectRegistry.registerOverride(`@happyvertical/smrt-timesheets:${model}`, {
    api: false, cli: false, mcp: false,
  });
}
```

Required tenant scoping remains in effect after closing these surfaces.

```ts
import { AttendanceService } from '@happyvertical/smrt-timesheets/attendance';

const attendance = new AttendanceService(db, { tenantId, profileId });
await attendance.punchIn(new Date('2026-10-01T08:00:00Z'));
await attendance.startBreak(new Date('2026-10-01T12:00:00Z')); // unpaid
await attendance.endBreak(new Date('2026-10-01T12:30:00Z'));
const punch = await attendance.punchOut(new Date('2026-10-01T16:00:00Z'), {
  workRefType: '@acme/jobs:WorkPackage', workRefId: 'wp-7', description: 'Framing',
});
```

Timestamps retain device milliseconds. `durationSeconds` is elapsed time minus
unpaid breaks, rounded once to the nearest whole second; paid breaks remain
included. Local time zone and payroll rounding policy belong to the consumer. Closing also ends an active break. New punches have the
non-null `openSlot` value `open`, with a unique database index on tenant, profile
and slot. Closed punches use a slot derived from their id, so PostgreSQL and
SQLite enforce one open punch without differing nullable-unique semantics.
The index compares native UUID owner columns directly, including PostgreSQL
UUID normalization. Breaks use the same
pattern per punch. Persisted ownership/start and closed intervals are immutable.
Direct ORM saves serialize against the parent punch and reject a close while a
break remains open or ends outside the punch.

A work reference is optional: attendance alone is not billable evidence. Passing
one on close, or calling `linkServiceTimeEntry(punch.id, work)` later, creates
one draft `ServiceTimeEntry` atomically and records `serviceTimeEntryId` on the
punch. Only the three declared work fields are copied; extra request fields cannot
replace the trusted tenant or participant. Repeating the same link returns that entry; changing attribution is
refused. Approval still uses the entry layer. Rollups must deduplicate this link,
not count both attendance and its entry. Zero-net-duration punches cannot create
service evidence.

`autoClose(now, maxOpenSeconds)` closes a due open punch at its configured
maximum duration and sets `reviewRequired`. It returns null before the deadline
or when already closed. If later committed attendance would be truncated it
refuses the operation for manual review. A scheduler calls this per authorized
actor; the package does not choose overtime, payroll, or shop-time-zone rules.

`replay(taps)` accepts `{ clientId, action, at, paid?, work? }`, where `action` is
`punchIn`, `punchOut`, `startBreak`, or `endBreak`. It sorts each batch by device
time, then client id. Client ids are durable and scoped to tenant/profile.
Successful taps set `recordedOffline` and `reviewRequired`. The conflict policy
is **committed attendance wins**: an event predating committed activity, or
invalid for the current state, gets a durable error outcome. Identical retries
return that outcome even after later shifts; changed payloads using the same id
are rejected. Database failures roll back the tap and receipt together and can
be retried. Earlier committed taps in the batch remain committed. Device clocks
are treated as supplied evidence, not server authentication; consumers should
apply device drift policy before replay. Replay receipts must be retained for as
long as clients can retry their ids.
