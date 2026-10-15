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

## Decimal-hours-only sources

When the accepted source is decimal hours and there is no independently supplied
integer elapsed duration, use `record({ ..., durationHours: '1.0005' })` (also
accepted by `correct`). Do not pass `durationSeconds: 3601.8`, round to an integer,
or manufacture timestamps. `durationHours` accepts positive plain decimal text,
without signs, whitespace or exponents, whose numeric conversion is positive,
finite and below `Number.MAX_SAFE_INTEGER`. The original string, including
trailing zeros, is retained exactly.

The service stores one reserved evidence item with kind
`@happyvertical/smrt-timesheets:duration-hours` and an `hours` string. Supply this
through `durationHours`, not through `record`'s general evidence list. The saved
entry has `durationSeconds: null`, `startedAt: null`, and `endedAt: null`.
Seconds or timestamps cannot accompany this quantity; timer sources still
require measured bounds. Null without the reserved quantity is invalid and is
never interpreted as zero. Generic collection writers use the same reserved
item and null fields; model save validates the combination.

`entry.durationHoursExact()` returns the original string for this representation
and null for ordinary integer-second entries. `entry.durationHours()` is a
JavaScript-number convenience for display: binary floating-point precision limits
apply. Use the exact accessor and your accepted commercial terms/amounts when
creating snapshots; do not recompute historical charges through the convenience
method. Commercial resolvers with representation restrictions implement the optional
pure `validateEntry(entry)` hook (synchronous or asynchronous). Approval awaits it
before freezing a submitted entry or invoking either pricing/pay resolver; a
rejection leaves the entry submitted and creates no snapshots. Fully completed
approval retries reuse their frozen snapshots without revalidation. For example, accepted `1.0005` hours at `12345` minor units/hour may carry
an already accepted `12351`-minor-unit charge. A commercial resolver returns that
amount and `{ hours: '1.0005', rateMinorUnits: '12345' }` in its immutable terms.
The entry evidence, charge and compensation snapshots freeze on approval;
corrections create a new entry and preserve original snapshots. For atomic
record/approval/correction workflows, create the service with the executor of
an owned `db.transaction`; approval retries preserve already written snapshots.

The existing nullable integer column and evidence JSON carry this representation:
no schema migration or rewriting of historical rows is needed. Public
`durationSeconds` is now `number | null`; readers must handle both cases.
`requireDurationSeconds()` throws an actionable error for hours-only sources.
The integer-second period rollup, projects subscription pricing, and support
plan pricing use this guard: their policies cannot silently convert absent
measurements into zero or rounded seconds. Use `ServiceEvidenceService` with an
hours-aware commercial resolver for these sources. Support's separate case-time
recording facade remains seconds-based; its shared entry view uses
`durationHours()` for display. Attendance measurement behavior is unchanged.

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

## Generated write actions

Generated CRUD writes are closed. The write path a generated app can call is
three service-backed REST actions on `ServiceTimeEntryCollection` (#4001):

| Route | Body | Permission |
|---|---|---|
| `POST /servicetimeentries/record` | work ref, `source` (`manual`/`timer`), times or `durationSeconds`/`durationHours`, optional `participantProfileId` | `servicetimeentries.record` |
| `POST /servicetimeentries/submit` | `{ entryId }` | `servicetimeentries.submit` |
| `POST /servicetimeentries/approve` | `{ entryId }` | `servicetimeentries.approve` (no super-admin bypass) |

Each delegates to `ServiceEvidenceService`, so `submittedAt`/`submittedBy`,
`approvedAt`/`approvedBy`/`approvalPath` (`operator`) and both snapshots are
set exactly as the service sets them. The tenant and the acting profile come
from the authenticated session, never the body. Recording or submitting
someone else's time needs `approve` as well. Install pricing for `approve`
as a factory, so a resolver that writes (client charges) runs on the request's
executor and transaction:

```ts
import { setServiceTimeEntryCommercialResolver } from '@happyvertical/smrt-timesheets';

setServiceTimeEntryCommercialResolver(({ options }) =>
  SubscriptionServiceCommercialResolver.create(options, provider),
);
```

Without a resolver, `approve` answers 409 `approval_not_configured`. MCP and
CLI stay read-only; there is no `reject` action yet (#3994).

## Closing the generated surface

The entry and both snapshots expose generated `list` / `get` on REST, CLI,
and MCP, with optional tenant scoping, and the entry's collection the write
actions above. An application that routes all time
and money through its own permission-gated services can close those surfaces
without declaring replacement models:

```ts
import { ObjectRegistry } from '@happyvertical/smrt-core';
import '@happyvertical/smrt-timesheets';

for (const name of [
  'ServiceTimeEntry',
  // Hosts the record/submit/approve actions on generated SvelteKit routes.
  'ServiceTimeEntryCollection',
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
`AttendanceBreak`, `AttendanceSegment`, and `AttendanceService`. Apply migrations for the new tables
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

for (const model of ['AttendancePunch', 'AttendanceBreak', 'AttendanceSegment']) {
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

### Running work segments

A shift is one punch; inside it a person works on a sequence of things. An
`AttendanceSegment` (table `attendance_segments`) is one running interval of work
inside a punch, with queryable columns `workRefType`/`workRefId`, an optional
second reference `taskRefType`/`taskRefId` (for example an operation; both or
neither), a short `kind` lane label, `description`, `startedAt`/`endedAt`,
`durationSeconds` and `closedReason` (`stop`, `switch`, `break`, `punchOut`).
Indexes on `(tenantId, workRefType, workRefId)` and `(tenantId, taskRefType,
taskRefId)` serve job costing; a unique `(tenantId, punchId, openSlot)` index
allows one open segment per punch. Segments never overlap each other or a break.

```ts
await attendance.punchIn(t(8));
await attendance.startWork(t(8), { workRefType: '@acme:WorkOrder', workRefId: 'WO-1',
  taskRefType: '@acme:Operation', taskRefId: 'SHEAR', description: 'Shear' });
await attendance.switchWork(t(10), { workRefType: '@acme:WorkOrder', workRefId: 'WO-2',
  taskRefType: '@acme:Operation', taskRefId: 'WELD', description: 'Weld' });
await attendance.startBreak(t(12));                        // closes the segment
await attendance.endBreak(t(13), { resumeWork: true });    // or attendance.resumeWork(t(13))
await attendance.punchOut(t(16));                          // closes the segment
```

`startWork`, `switchWork` (closes the open segment and opens the next at the same
instant), `stopWork`, `resumeWork` (reopens the work a break interrupted),
`currentWork()` and `segments(punchId)` are the service surface. `startBreak`,
`punchOut`, `autoClose` and replayed taps close the open segment. Closed segments
are immutable; ownership, references and start are immutable always. Closing a
punch with an open segment, or a segment outside the punch, is refused.

Segments are attendance evidence, not service time entries: they do not create
`ServiceTimeEntry` rows and `punchOut(at, work?)` is unchanged (one draft entry
for the whole punch; `taskRef*` and `kind` ride in its `metadata`). A consumer that
costs jobs from segments should not also cost the punch-level entry. Rollups
still deduplicate `serviceTimeEntryId`.

To compose segment work with other attendance mutations (corrections, custom
replay actions) atomically, use `attendance.withTransaction(async (tx) => ...)`
and the exported helpers `openSegment`, `listSegments`, `beginSegment`,
`replaceSegment`, `endSegment`, `continueSegment` and `closeOpenSegment`, which
take the `AttendanceContext` (`tx.punches`, `tx.breaks`, `tx.segments`, `tx.db`)
and an open punch.

A work reference is optional: attendance alone is not billable evidence. Passing
one on close, or calling `linkServiceTimeEntry(punch.id, work)` later, creates
one draft `ServiceTimeEntry` atomically and records `serviceTimeEntryId` on the
punch. Only the three declared work fields are copied; extra request fields cannot
replace the trusted tenant or participant. Repeating the same link returns that entry; changing attribution is
refused. Approval still uses the entry layer. Rollups must deduplicate this link,
not count both attendance and its entry. Zero-net-duration punches cannot create
service evidence.

`autoClose(now, deadline)` closes a due open punch and sets `reviewRequired`.
`deadline` is either a fixed maximum open duration in seconds (reason
`maxDuration`) or a per-punch resolver `(punch) => Date | { deadline, reason? }
| null`, for example the end of the shop day in the shop's time zone or the
scheduled shift end; `null` leaves the punch open. The open work segment and
break close at the deadline and the punch records `autoCloseReason` (write-once,
only through `autoClose`). It returns null before the deadline or when already
closed, and refuses a resolved deadline before the punch started. If later
committed attendance would be truncated it refuses the operation for manual
review. A scheduler calls this per authorized actor; the package does not choose
overtime, payroll, or shop-time-zone rules.

Provenance is optional and consumer-owned (no enum; at most 64 characters, trimmed):
`punchIn(at, { source, device: { type, id } })` stores `source`, `deviceRefType` and
`deviceRefId` on the punch (device type and id together, indexed with the tenant), and
`startBreak(at, paid, { kind })` stores `kind` on the break. They are immutable once
saved except through `AttendanceCorrectionService` (`addPunch({ source, device })`,
`saveBreak({ kind })`). All columns default to `''`, so existing rows and calls are unchanged.
Provenance, `kind` and `autoCloseReason` are additive columns on `attendance_punches` and `attendance_breaks`:
migrate them as `TEXT NOT NULL DEFAULT ''` (a NULL left on an older row is read as `''`).

`replay(taps, options?)` accepts `{ clientId, action, at, paid?, work?, source?, device?, kind? }`, where `action` is
`punchIn`, `punchOut`, `startBreak`, `endBreak`, or a work action (`startWork`,
`switchWork` (both require `work`), `stopWork`, `resumeWork`). It sorts each batch by device
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

Work actions replay under the same client id and in the same transaction as punch
and break changes; the outcome carries `segmentId`. Replay options:

```ts
await attendance.replay(taps, {
  // Choose each tap's effective time. Called once per tap without a receipt.
  resolveAt: ({ tap, deviceAt, serverNow, waitedMs, actor }) =>
    waitedMs <= 12 * 3600_000
      ? { at: deviceAt, reviewRequired: false }
      : { at: serverNow, reviewRequired: true },
  // Optionally name the stored reason of a refused tap.
  refusal: (tap, error) => ({ code: 'device_busy', message: 'Finish current task first' }),
});
```

The receipt hashes the tap as sent, so a retry with the same `clientId` still
matches even though the stored time differs; the outcome then has `resolvedAt`.
Punches are always flagged `reviewRequired`; `reviewRequired: true` from the
resolver also flags the resulting work segment (`AttendanceSegment.reviewRequired`,
a new column). A refused outcome stores `{ error, code }`: `code` defaults to the
`AttendanceConflict.code` (`predates_committed`, `punch_open`, `no_open_punch`,
`break_open`, `no_open_break`, `during_break`, `work_open`, `no_open_work`,
`no_resumable_work`, or `conflict`), so a device screen can say why. Resolved times
that break chronology are refused like any other tap.

### Correcting closed attendance

Closed punches, breaks and segments are immutable to every direct write.
`AttendanceCorrectionService` is the one sanctioned path around that, and it
leaves a paper trail. Construct it with the **correcting** person as `actor`;
each request names the `subjectProfileId` whose time it is. As with
`AttendanceService`, your application authorizes the actor (and decides whether
they may correct this subject) first.

```ts
import { AttendanceCorrectionService } from '@happyvertical/smrt-timesheets/attendance';
import { confirmedTimecardGuard } from '@happyvertical/smrt-timesheets/rollup';

const fix = new AttendanceCorrectionService(
  db,
  { tenantId, profileId: foremanId },
  { guard: confirmedTimecardGuard }, // optional, see below
);
const base = { subjectProfileId: welderId, reason: 'forgot to clock out' };

await fix.correctPunch({ ...base, punchId, endedAt: new Date('2026-10-01T15:30:00Z'),
  acknowledgementRequired: true });
await fix.addPunch({ ...base, reason: 'missed punch', startedAt, endedAt });
await fix.saveBreak({ ...base, punchId, startedAt, endedAt, paid: false }); // add
await fix.saveBreak({ ...base, punchId, breakId, endedAt });                // change
await fix.removeBreak({ ...base, breakId });
await fix.saveSegment({ ...base, punchId, startedAt, endedAt, work });      // add
await fix.saveSegment({ ...base, punchId, segmentId, endedAt });            // change
await fix.removeSegment({ ...base, segmentId });

// the welder, constructing the service as themselves:
await new AttendanceCorrectionService(db, { tenantId, profileId: welderId })
  .acknowledge(correctionId);
```

Every method runs in one transaction serialized with the subject's own taps. It
validates the resulting layout (everything inside its punch, no overlapping
breaks, segments or other punches, no segment across a break), recomputes
`durationSeconds` and `unpaidBreakSeconds`, and appends an `AttendanceCorrection`
row (`attendance_corrections`: `kind`, `subjectProfileId`, `actorProfileId`,
`punchId`, `targetId`, `beforeState`/`afterState` JSON, a required non-blank
`reason`, `acknowledgementRequired`, `acknowledgedAt`/`acknowledgedByProfileId`).
Rows are append-only: the only later change is the subject's single
`acknowledge()`, and `listForPunch(punchId)` / `pendingAcknowledgements()` read
the ledger. The ledger has no generated operations, and every ledger,
closed-break and closed-segment write (insert, acknowledge, delete) is
service-only: a generic `save()`, `delete()` or collection `create()` is refused. Notes:

- Moving a punch edge past a break or segment is refused: correct those first.
- **Open punches** accept three corrections, each with a ledger row and the
  same lock: `correctPunch({ punchId, startedAt })` changes the start only (it
  cannot close the punch or move past its earliest break or segment);
  `saveBreak`/`removeBreak`/`saveSegment`/`removeSegment` work on *closed*
  intervals inside it (the open break or segment stays `AttendanceService`'s:
  `startBreak`, `startWork`, ...); and `addPunch({ open: true, startedAt,
  breaks?, segments?, ... })` records a missed clock-in that is still running,
  with its closed breaks and segments, refused if the subject already has an
  open punch. An open punch's durations are set when it closes.
- `correctPunch` clears `reviewRequired` (a person reviewed it). A linked
  *draft* `ServiceTimeEntry` is kept in step; a submitted or approved one
  refuses the correction until it is corrected with `ServiceEvidenceService`.
- **Confirmed timecards.** A confirmed `PeriodTimecard` never changes, so
  correcting its sources would leave card and attendance disagreeing for good.
  Pass `confirmedTimecardGuard` (from `./rollup`) and a correction overlapping a
  confirmed (or submitted) card is refused before any write; call
  `PeriodRollupService.reopen()` first, correct, then `rollup()` again. Any other lock can be supplied as `guard`.
- Closed `AttendanceBreak`/`AttendanceSegment` rows can no longer be deleted
  directly; `removeBreak`/`removeSegment` are the path.

## Period timecards

`./rollup` provides per-person integer-second regular/overtime rollups, immutable
confirmation (with an optional submitted step), audited reopening, and attributed append-only adjustments. Consumer resolvers own
calendar/timezone, holiday and overtime rules. See the [contract and example](agents/period-rollup.md).

## Effective-dated labour pricing

`DatedLabourCommercialResolver` is an opt-in `ServiceCommercialResolver` for
host-authorized human labour. Supply `DatedLabourCommercialInput` with an explicit
`tenantId`, `participantProfileId`, `workDate` (`YYYY-MM-DD`), uppercase three-letter
`currency`, `billable` boolean, and `schedule`. Each `DatedLabourRatePeriod` has
`effectiveFrom`, optional `effectiveUntil` (exclusive), `currency`, and independent
`customer`, `wage`, and `burden` rates. Each `DatedLabourRate` supplies `id`, `version`,
and `rateMinor`: nonnegative hourly minor-unit decimal text, up to 18 fractional
digits, at most 40 total characters, and within JavaScript's safe numeric range.
Burden is an **additive hourly amount**, not a percentage; the host supplies any percentage conversion and
classification policy. There are no statutory, tax, overtime or currency defaults.

The resolver rejects invalid calendar dates, overlapping periods (including
unselected periods), missing applicable rates, currency mismatches, unsafe rates,
unsafe totals, ambiguous duration evidence and mismatched tenant/worker identity.
Adjacent half-open periods are valid. Decimal-hours evidence uses its original
text (with the same precision and text-length limits as rates); measured seconds use the exact rational `seconds / 3600`. Each of customer,
wage and burden rounds half up independently to integer minor units. Compensation
`amount` preserves the public **provider earning** contract: rounded wage only.
Private `terms.loadedCostMinor` is the safe integer sum of rounded wage and burden.
For example, `1.0005` hours at customer `12345`, wage `6000`, burden `1000` yields
charge `12351`, provider earnings `6003`, burden `1001`, and loaded cost `7004`.
Nonbillable time yields zero customer charge and retains earnings and loaded cost. Even nonbillable time requires valid customer rate terms.

The host must authorize the schedule, worker and tenant and bind the supplied
work date to its authoritative entry evidence. Base entries have no authoritative
work-date field; the resolver never infers one from timestamps or process time.
Construct the resolver for the authorized entry's work date and pass it to
`ServiceEvidenceService.create(options, resolver)`. Existing resolvers and legacy
approval defaults are unchanged. Selection copies and whitelists supplied terms,
so later caller mutation cannot change an in-flight approval. Client snapshot
terms contain only the customer rate's ID, version and hourly rate plus work-date,
period, currency, billability, duration and rounding provenance. Compensation
terms contain separate wage/burden IDs, versions, hourly rates and rounded amounts,
plus `loadedCostMinor`; never expose those snapshots to client audiences. A payable
reader uses snapshot `amount`. A loaded-margin reader uses charge minus private
`loadedCostMinor`; charge minus snapshot `amount` remains the existing earnings-only
margin, not margin after employer burden.

The existing lifecycle makes persisted snapshots immutable and corrections append
new evidence. Approval remains resumable, not an all-or-nothing transaction. When
reconstructing a resolver after an interrupted approval, the host must restore
**the originally selected authorized date and rate terms**, not reselect from a
newly edited schedule; this helper introduces no persistence schema or schedule
lookup service. Fully completed approval retries retain their existing snapshots.

### Percentage burden and analytical labour valuation

`DatedPercentageLabourCommercialResolver` adds opt-in exact percentage-derived
burden without changing the additive dated resolver. `reconcileLabourValuation`
compares canonical approved loaded costs with an explicitly selected analytical
aggregate; it never reprices or posts approval facts. Both retain private
compensation boundaries. See [the exact contract and validation matrix](agents/labour-valuation.md)
for input units, immutable provenance, supported modes and host responsibilities.
