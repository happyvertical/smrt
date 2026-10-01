# Service Time Entry migration

`ServiceTimeEntry` moved from `@happyvertical/smrt-support` to
`@happyvertical/smrt-projects` in issue #1955, and from there to
`@happyvertical/smrt-timesheets` in issue #3288. smrt-projects re-exports the
entry, its snapshots, their collections, and `ServiceEvidenceService`
unchanged; `caseId` / `specialistId` now exist only on smrt-support's subtype.
Consumers holding `service_time_entries` rows need no schema change — see the
smrt-timesheets README ("Migrating from smrt-projects / smrt-support").

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
