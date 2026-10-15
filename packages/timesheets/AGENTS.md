# smrt-timesheets

Shared time entries: who (a `smrt-profiles` Profile, or an agent) worked how
long on what (a generic work reference), whether it was approved, and the
immutable charge / compensation snapshots taken at approval. Moved out of
`smrt-projects` / `smrt-support` in #3288 so shops, builders, and service
desks share one model instead of re-implementing it.

This package contains **layer 1 (entry)**, **layer 2 (attendance)**, and
**layer 3 (period rollup)**.
`src/attendance/` owns punches, breaks, atomic transitions and durable offline
receipts; `./attendance` is the public subpath. Period rollup belongs in this
package too, never projects or support. See the README attendance contract.
Attendance services accept trusted session actors, serialize mutations per
actor, and bind every write to one executor. The new tables use non-null unique
open slots, not nullable unique keys. A linked entry is draft evidence, and
rollups must deduplicate `AttendancePunch.serviceTimeEntryId`.
`AttendanceSegment` (`attendance_segments`) is a running work interval inside a
punch: queryable `workRef*`/`taskRef*`/`kind` columns, one open per punch
(`openSlot`), closed by `startBreak`/`punchOut`/`autoClose`, never overlapping
breaks or each other, immutable once closed. It creates no `ServiceTimeEntry`.
Closed punches, breaks and segments change only through
`AttendanceCorrectionService` (`attendance/correction-service.ts`), which sets a
per-instance capability (`attendance/write.ts`, not exported) that lifts the
models' closed-interval checks for one save, validates the whole punch layout,
recomputes durations and appends an `AttendanceCorrection` (append-only ledger,
no generated operations; only a first acknowledgement by the subject may update
a row). Never export `write.ts`. Punch `source`/`deviceRef*` and break `kind` are immutable except through corrections; `autoCloseReason` is write-once via `persistAutoClose`. A confirmed `PeriodTimecard` is honoured by the
opt-in `confirmedTimecardGuard` (`rollup/correction-guard.ts`), which refuses
while a card is submitted or confirmed. `PeriodRollupService.reopen()` returns
such a card to `open` and appends a `TimecardReopening` (`timecard_reopenings`,
append-only, service-only via `rollup/write.ts`); `submit()` is the optional
open -> submitted step (`requireSubmission` makes it mandatory) (#3950).
Segment transitions live in `attendance/segments.ts`; compose them with other
attendance writes via `AttendanceService.withTransaction`. Any new attendance
table must be added to the `includeObjects` lists in the `*.optional.test.ts`
files.

## Models

| Model | Table | Notes |
|---|---|---|
| `ServiceTimeEntry` | `service_time_entries` | `workRefType` + `workRefId`, `participantKind` (`human` \| `agent`), `participantProfileId` / `agentRef`, `source`, `startedAt` / `endedAt` / `durationSeconds`, status machine, `correctionOfId` |
| `ServiceChargeSnapshot` | `service_charge_snapshots` | Client charge, integer minor units (#2401), one per entry |
| `ServiceCompensationSnapshot` | `service_compensation_snapshots` | Provider earning, integer minor units, one per entry |

`ServiceEvidenceService` records, submits, approves (writing both snapshots
through a `ServiceCommercialResolver`), and corrects. `smrt-projects` supplies
`SubscriptionServiceCommercialResolver` for #1925 pricing.

## Generated write actions (#4001)

Generated CRUD writes stay closed. `ServiceTimeEntryCollection` hosts the only
generated writes, `record` / `submit` / `approve` (`POST
/servicetimeentries/<action>`, body `{ entryId }` for submit/approve), on REST
only; MCP and CLI stay read-only until per-operation MCP authorization (#4004).
`services/time-entry-actions.ts` delegates each to `ServiceEvidenceService`, so
the trail and snapshots are set in one place. `services/action-principal.ts`
takes identity from the tenancy ALS, then the smrt-users session ALS, never the
body; authorizes `servicetimeentries.<action>` with `assertOperationPermission`
(system context never bypasses; `approve` refuses super-admin bypass); and
stamps the user's linked profile. Only the participant records/submits their
own time unless the caller holds `approve`. `approve` prices with the host's
`setServiceTimeEntryCommercialResolver()` — a factory called per request with
the collection's options, so a writing resolver shares the request executor;
without one it is a 409 and writes nothing. The runtime REST transport gates
a collection-hosted action on the ITEM's `api.include`, SvelteKit on the
collection's, so both list the actions;
a consumer closing them overrides both registrations. The collection and both
snapshot collections carry their own `@smrt()` surface: undecorated, they
published generated create/update/delete MCP tools. `reject` waits for #3994.

## Recipe

`src/recipes.ts` declares one `SmrtRecipe`, `timesheets.time-entries`
(label "Time entries", section `work`), emitted into the built
`manifest.json` and `smrt-knowledge.json` `recipes`. It shows
`ServiceTimeEntry` alone, with the generic work reference, evidence, agent
and approval-trail fields hidden; attendance and rollup models stay out of
it. `status` and its trail are hidden and locked, and the help never says to
set them: `save()` accepts a bare transition, so submit and approve must go
through `ServiceEvidenceService` (the recipe declares no surface for that). Help lives in `src/time-entries.recipe.md` (#3591); keep it and the recipe
in plain language. See [core recipes](../core/agents/recipes.md).

## Invariants

- **No domain foreign key on the base.** Work context is the generic
  `workRefType` (qualified class name) + `workRefId`. A domain adds its own
  context by subclassing over the same table — smrt-support's
  `ServiceTimeEntry` adds `caseId` / `specialistId` and extends
  `frozenFieldNames()` so they freeze on approval.
- **Entries carry no rate.** Money lives only on the snapshots, `= 0`
  integer initializers (INTEGER columns). Never `= 0.0`. Snapshot `save()`
  rejects an `amount` that is not a safe integer (`VALIDATION_INVALID_VALUE`),
  so SQLite cannot silently store `19.99`; fix a fractional resolver at its
  source rather than rounding here.
- **Approved evidence never changes.** `save()` enforces
  `SERVICE_TIME_ENTRY_STATUS_TRANSITIONS` and compares the frozen fields with
  the stored row. A correction is a new row (`correctionOfId`), the original
  flips to `corrected`. Snapshots are immutable after their first save.
- **Old qualified names are aliases.** Each model declares its pre-#3288
  `@happyvertical/smrt-projects:*` name in `previousQualifiedNames` (#3338;
  `packages/core/agents/model-moves.md`). smrt-projects must never list these
  classes in its manifests again (`CONFIG_QUALIFIED_NAME_ALIAS_COLLISION`),
  and no subtype (smrt-support's, or a consumer's closing subclass) may
  redeclare an alias (two claimants). Known gap: a same-named subtype that
  replaces a moved class drops that class's alias, and the replaced class's
  own `@happyvertical/smrt-timesheets:*` name stops resolving too — guidance
  for apps with smrt-support must name `@happyvertical/smrt-support:ServiceTimeEntry`.
  Support's vitest environment keeps both classes registered, so verify this
  against built packages, not package tests. `projects/src/__tests__/legacy-qualified-identity.test.ts` pins
  the projects-only contract.
- **Table names are a compatibility contract.** `service_time_entries` and the
  two snapshot tables hold existing production rows from smrt-projects /
  smrt-support; renaming any of them, or adding a discriminator, is a data
  migration.

## One table family

Classes may share a table only as one inheritance chain. Core resolves
same-named subclasses by constructor ancestry at runtime and qualified manifest
ancestry at build registration; the deepest subtype wins across N levels.
Sibling or unrelated types cannot share the table. `smrt-projects` re-exports
the base; `smrt-support` subclasses it directly.

Consumers closing package routes should call
`ObjectRegistry.registerOverride(qualifiedName, { api: false, mcp: false,
cli: false, tenancy: { mode: 'required' } })` after importing the model and before
constructing transports. This tightens the existing registration without a new
subtype. See core's README for startup order, static route generation, and reset
semantics. `src/__tests__/consumer-closed-surface.test.ts` also covers existing
manifest subclass consumers. The snapshots' explicit `time_entry_id` conflict
key is not rewritten when a consumer requires tenancy; widening it remains a
consumer schema change.

Subclasses restate their fields: package-isolated manifest scanning does not
read dependency sources, so an unrestated subclass manifest has no columns.

## Svelte UI

`./svelte` exports `TimeEntryCard`, `TimeEntryList`, `TimeSummary`,
`DurationDisplay`, and `TimeEntryApprovalQueue` (props-driven, plain view
objects, `smrt-ui` primitives, `smrtRawPrimitives: "strict"`). smrt-projects
and smrt-support re-export them from their own `./svelte` subpaths.
Card/list/summary message keys keep their `projects.*` namespace: tenant
language overrides are stored by key, and renaming would orphan them. New
keys use `timesheets.*`.

Display components keep the legacy one-decimal hours format by default. A
consumer that retains more precise source evidence supplies `hoursFormatter`;
card/list/queue detail snippets carry domain evidence without widening the base
view. ApprovalQueue's optional action snippet replaces its callback controls so
the host can own a native form, request identity, authorization and retry flow.
Display currency codes are open ISO strings and amounts remain integer minor
units; never put private rates into a view that should not expose them.

## Validation

```sh
pnpm --filter @happyvertical/smrt-timesheets test
pnpm --filter @happyvertical/smrt-timesheets test:postgres
pnpm --filter @happyvertical/smrt-timesheets typecheck
pnpm --filter @happyvertical/smrt-timesheets build
pnpm --filter @happyvertical/smrt-projects test
pnpm --filter @happyvertical/smrt-support test
```

Schema-affecting edits must keep `service-time-entry-compat.test.ts` (projects,
support) and `service-time-entry-migration-plan.test.ts` (support) green: a
pre-move table must plan no DDL.

## Period rollup

Layer 3 lives under `src/rollup/` and the `./rollup` subpath. See
[period-rollup.md](agents/period-rollup.md) for resolver, source clipping,
confirmation, attributed adjustments, isolation, and transaction contracts.
Timecards and adjustments have closed generated surfaces and service-only
model writes; never bypass the instance capability with generic persistence.

Replay hashes the tap AS SENT (action, device `at`, paid, work, and `source`/`device`/`kind` only when present, so older receipts still match) so retries match;
`replay(taps, { resolveAt, now, refusal })` only changes the stored time and
reason. Never hash the resolved time. Work actions (`startWork`, `switchWork`,
`stopWork`, `resumeWork`) run in the tap's transaction via `apply()`. Refusals store
`code` from `AttendanceConflict.code`; give new conflicts a code.
