# smrt-timesheets

Shared time entries: who (a `smrt-profiles` Profile, or an agent) worked how
long on what (a generic work reference), whether it was approved, and the
immutable charge / compensation snapshots taken at approval. Moved out of
`smrt-projects` / `smrt-support` in #3288 so shops, builders, and service
desks share one model instead of re-implementing it.

This package is **layer 1 (entry)**. Attendance (punches, breaks, offline
replay) and period rollup (per-person timecards) are planned as later modules
of this same package; do not add them to projects or support.

## Models

| Model | Table | Notes |
|---|---|---|
| `ServiceTimeEntry` | `service_time_entries` | `workRefType` + `workRefId`, `participantKind` (`human` \| `agent`), `participantProfileId` / `agentRef`, `source`, `startedAt` / `endedAt` / `durationSeconds`, status machine, `correctionOfId` |
| `ServiceChargeSnapshot` | `service_charge_snapshots` | Client charge, integer minor units (#2401), one per entry |
| `ServiceCompensationSnapshot` | `service_compensation_snapshots` | Provider earning, integer minor units, one per entry |

`ServiceEvidenceService` records, submits, approves (writing both snapshots
through a `ServiceCommercialResolver`), and corrects. `smrt-projects` supplies
`SubscriptionServiceCommercialResolver` for #1925 pricing.

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
  replaces a moved class drops that class's alias. `projects/src/__tests__/legacy-qualified-identity.test.ts` pins
  the projects-only contract.
- **Table names are a compatibility contract.** `service_time_entries` and the
  two snapshot tables hold existing production rows from smrt-projects /
  smrt-support; renaming any of them, or adding a discriminator, is a data
  migration.

## One table family

Classes may share a table only as one inheritance chain, and the registry
resolves a chain of same-named classes by "child wins" on the simple name.
That works for exactly one subtype level per table (base → subtype); a third
same-named level makes the middle class look like it extends its own child on
the manifest path (`CONFIG_TABLE_NAME_COLLISION`). Therefore:

- `smrt-projects` **re-exports** these classes (no projects subclass).
- `smrt-support` subclasses `ServiceTimeEntry` directly from this package.
- A consumer that needs its own surface (e.g. teamworks-os closing every
  generated route with `api: { include: [] }` and
  `@TenantScoped({ mode: 'required' })`) declares a same-named subclass over
  `service_time_entries`; its manifest entry replaces the package's. It cannot
  also install smrt-support's subtype on the same table.
  The same applies to both snapshots;
  `src/__tests__/consumer-closed-surface.test.ts` holds that contract for all
  three models. The snapshots' explicit `time_entry_id` conflict key is not
  rewritten when a consumer requires tenancy; widening it is the consumer's
  schema change, never a package default.

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
