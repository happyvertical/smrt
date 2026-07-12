# Service Time Entry migration

`ServiceTimeEntry` moved from `@happyvertical/smrt-support` to
`@happyvertical/smrt-projects` in issue #1955.

There is no data migration and no duplicate table. The support import is a
compatibility subtype over the shared class; it restates the schema so an
isolated support manifest remains self-contained, while both paths map to the
existing `service_time_entries` table:

```ts
// Preferred shared import
import { ServiceTimeEntry, ServiceEvidenceService } from '@happyvertical/smrt-projects';

// Supported compatibility import
import { ServiceTimeEntry } from '@happyvertical/smrt-support';
```

Support-specific `SupportCharge` and `SupportCompensation` records remain
readable. New cross-domain approvals should use `ServiceEvidenceService` with
`SubscriptionServiceCommercialResolver`; this records a #1925 Client Charge
reference and a separate provider-compensation snapshot without rewriting the
approved duration or evidence.
