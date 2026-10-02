# Service Time Entry migration

`ServiceTimeEntry` moved from `@happyvertical/smrt-support` to
`@happyvertical/smrt-projects` in issue #1955, and from there to
`@happyvertical/smrt-timesheets` in issue #3288. smrt-projects re-exports the
entry, its snapshots, their collections, and `ServiceEvidenceService`
unchanged; `caseId` / `specialistId` now exist only on smrt-support's subtype.
Consumers holding `service_time_entries` rows need no schema change — see the
smrt-timesheets README ("Migrating from smrt-projects / smrt-support").

**pnpm consumers must add a direct `@happyvertical/smrt-timesheets`
dependency.** The CLI's manifest discovery (`smrt db:migrate`, `db:status`,
`db:diff`) reads only top-level `node_modules` packages, and smrt-projects'
own manifest no longer declares the moved models. Without the direct
dependency, `service_time_entries`, `service_charge_snapshots`, and
`service_compensation_snapshots` drop out of the planned schema: a fresh
database never gets them (so `ServiceEvidenceService` fails the runtime table
check), and an existing database reports them as orphan tables. npm and Yarn
hoist the package and are unaffected.

```bash
pnpm add @happyvertical/smrt-timesheets
```

**Old class names keep resolving as deprecated aliases.** The moved classes
declare `previousQualifiedNames` (#3338), so stored or declared
`@happyvertical/smrt-projects:ServiceTimeEntry`, `:ServiceChargeSnapshot`, and
`:ServiceCompensationSnapshot` references — polymorphic `meta_type` rows,
`@crossPackageRef` and relationship targets, playbook `model:` names — resolve
to the `@happyvertical/smrt-timesheets:*` classes with a one-time deprecation
warning, and new association writes store the current name. `smrt doctor --db`
counts remaining stored references; `smrt db:migrate-qualified-names` is the
opt-in backfill. Move source references to the new names before the aliases
are removed in a later breaking release. A same-named subtype that replaces a
moved class drops its alias for now — with smrt-support installed the
`ServiceTimeEntry` alias does not resolve; see the smrt-timesheets README for
the workaround.

The #1955 notes below still describe the support side.

There is no data migration and no duplicate table. The support import is a
compatibility subtype over the shared class; it restates the schema so an
isolated support manifest remains self-contained, while both paths map to the
existing `service_time_entries` table:

```ts
// Preferred shared import (#3288)
import { ServiceTimeEntry, ServiceEvidenceService } from '@happyvertical/smrt-timesheets';

// Still supported: the same classes, re-exported
import { ServiceTimeEntry, ServiceEvidenceService } from '@happyvertical/smrt-projects';

// Support subtype with caseId / specialistId
import { ServiceTimeEntry } from '@happyvertical/smrt-support';
```

Support-specific `SupportCharge` and `SupportCompensation` records remain
readable. New cross-domain approvals should use `ServiceEvidenceService` with
`SubscriptionServiceCommercialResolver`; this records a #1925 Client Charge
reference and a separate provider-compensation snapshot without rewriting the
approved duration or evidence.
