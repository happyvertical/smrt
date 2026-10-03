# Period timecards

`@happyvertical/smrt-timesheets/rollup` exports `PeriodRollupService`,
`PeriodTimecard`, `TimecardAdjustment`, their collections, and resolver types.
The package root also exports them. SQLite and PostgreSQL are supported.
Create application tables through normal migrations; neither service provisions
schema. The attendance option additionally requires the attendance tables.

Construct a service only after authenticating and authorizing its trusted
`{ tenantId, profileId }` scope. A conflicting ambient tenant is rejected.
`options.actorProfileId` records a separately authorized supervisor; it defaults
to the subject profile for self confirmation/correction. Never accept this
trusted scope or attribution unchecked from request input. Profile authorization
is consumer-owned; the service filters every source/card/adjustment read by its
trusted subject and tenant. Generic API, CLI and MCP surfaces are closed by
default; consumer registry overrides may further restrict them (#3318).

## Resolver contract

`periodFor(at, actor)` supplies half-open UTC `startsAt`/`endsAt`, an IANA
`timezone`, a nonempty policy `version`, and a JSON `rules` snapshot.
The consumer owns period length, calendar start day, timezone and DST, overtime
thresholds, holidays and classification. The requested instant must be inside
the window. Overlapping windows for existing cards are rejected: introduce a new
calendar at a boundary after existing windows, and use adjustments for already
confirmed periods.

`classify(period, sources, actor)` returns nonnegative safe integer
`regularSeconds` and `overtimeSeconds`, whose sum must equal source seconds.
Inputs are detached so resolver mutation cannot rewrite evidence. Resolver
exceptions, malformed windows, invalid timezone, fractional/unsafe totals and
nonconserving classification abort the transaction. No Alberta or other
jurisdiction rule is assumed, and no pay rate or money is stored.

A configurable UTC calendar example (illustrative policy, not payroll advice):

```ts
import { PeriodRollupService, type PeriodRulesResolver } from
  '@happyvertical/smrt-timesheets/rollup';

const settings = {
  lengthDays: 14, startDay: 1, timezone: 'UTC', // 0 = Sunday
  anchor: '2026-01-05T00:00:00Z', // aligned Monday; anchors fortnight phase
  thresholdSeconds: 80 * 3600,
  holidays: ['2026-12-25'],
};
const resolver: PeriodRulesResolver = {
  async periodFor(at) {
    const anchor = new Date(settings.anchor);
    if (anchor.getUTCDay() !== settings.startDay || settings.timezone !== 'UTC')
      throw new Error('Use a timezone-aware calendar resolver for local periods');
    const length = settings.lengthDays * 86400000;
    const start = anchor.getTime() +
      Math.floor((at.getTime() - anchor.getTime()) / length) * length;
    return {
      startsAt: new Date(start), endsAt: new Date(start + length),
      timezone: settings.timezone, version: 'shop-policy-v1', rules: settings,
    };
  },
  async classify(period, sources) {
    const rules = period.rules as typeof settings;
    // This example assigns a contribution to its clipped start's UTC date.
    // Local daily rules should split contributions at their own local midnight.
    let regular = 0;
    let holiday = 0;
    for (const source of sources) {
      if (rules.holidays.includes(source.startsAt.slice(0, 10))) holiday += source.seconds;
      else regular += source.seconds;
    }
    return {
      regularSeconds: Math.min(regular, rules.thresholdSeconds),
      overtimeSeconds: holiday + Math.max(0, regular - rules.thresholdSeconds),
    };
  },
};
const rollups = new PeriodRollupService(db, authorizedSubject, resolver,
  { attendance: true, actorProfileId: authenticatedSupervisorProfileId });
const card = await rollups.rollup(new Date());
await rollups.confirm(card.id!);
await rollups.adjust(card.id!, {
  operationId: requestId, regularSeconds: 900, overtimeSeconds: 0,
  reason: 'Approved correction after confirmation',
});
const effectiveSeconds = await rollups.totals(card.id!);
```

A timezone-aware resolver must compute each local boundary separately: a local
day crossing DST is not necessarily 86400 seconds. Resolvers can use an app's
existing calendar library; no new timezone dependency or implicit default is
introduced here.

## Evidence and immutability

Decimal-hours-only entries have no measured integer seconds. The seconds-only
rollup rejects these sources explicitly when their approval instant falls in the
requested period; it never rounds them or counts null as
zero. Use an hours-aware consumer policy for that source representation.

Only approved human `ServiceTimeEntry` rows for the subject count; corrected
ancestors do not. Correction chains must remain within that subject/tenant and
point to corrected parents. Multiple approved descendants of one root are
rejected as ambiguous rather than double-counted. Entries with both `startedAt`
and `endedAt` allocate their declared seconds
proportionally across the period using exact integer prefix division, preserving
seconds over adjacent periods. Unbounded entries count at `startedAt`, or, when
absent, `approvedAt`; an end-only timestamp does not create an interval. Missing
both attribution timestamps is an error. This is time attribution, not a
claim that a manual entry has a continuous wall-clock duration.

With `attendance: true`, closed punches without `reviewRequired` count, excluding
unpaid breaks and retaining paid breaks. Open/review-required punches do not
count. Linked attendance is authoritative: its evidence entry and any approved
correction descendants are excluded, including when the punch is still under
review or outside the requested period. Unlinked approved work entries and
attendance both count; consumers must link overlapping evidence explicitly.
Source snapshots preserve each paid attendance segment and entry identity.

Repeated rollup updates one open card per tenant/person/start; a confirmed card
cannot be recomputed. Confirmation is attributed and idempotent. Model save,
collection create/update/upsert and object/collection delete cannot bypass the
service. Model mutation capabilities are per-instance and not exported.
Direct SQL is a trusted administrative boundary, not an exposed application API.
Profile/card foreign keys restrict deletion to preserve history.

Adjustments contain signed integer regular/overtime deltas, reason, operation
key and actor attribution. A retry reuses its row only for the exact same
payload and actor. Effective totals may never become negative or unsafe.
Adjustments never alter the confirmed row or source snapshot. Undo an adjustment
with a separately attributed compensating adjustment, never deletion.

All service mutations use a root transaction, transaction-bound collections,
embedded writer serialization or a PostgreSQL tenant/person advisory lock.
Outputs are reloaded on the root executor after commit. Rollup reads are an
application snapshot: subsequent source approvals/corrections appear on the
next open rollup, and confirmed cards require explicit adjustments.
