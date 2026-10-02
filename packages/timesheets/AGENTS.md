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
