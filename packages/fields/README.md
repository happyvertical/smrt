# @happyvertical/smrt-fields

Layered field policy for SMRT objects: personalize per-field defaults,
visibility tiers (basic/advanced/hidden), help text, labels, ordering, and
org locks at app, tenant, and user scope — over the code-authored
`@field({ ui })` seed.

```typescript
import {
  FieldPolicy,
  FieldPolicyCollection,
  resolveFieldPolicy,
  resolveFieldPolicyExplained,
} from '@happyvertical/smrt-fields';

// An org (tenant) demotes an optional field and sets a default
const policies = await FieldPolicyCollection.create({ db });
await policies.create({
  objectRef: '@happyvertical/smrt-content:Article',
  fieldName: 'summary',
  scopeType: 'tenant',
  tenantId,
  visibility: 'advanced',
  defaultValue: JSON.stringify('TBD'),
});

// Resolve the effective policy for a user in that tenant
const resolved = await resolveFieldPolicy(
  '@happyvertical/smrt-content:Article',
  { tenantId, userId, db },
);
resolved.fields.summary.visibility; // 'advanced'

// Explain variant: per-layer contributions for admin/gear UIs
const explained = await resolveFieldPolicyExplained(
  '@happyvertical/smrt-content:Article',
  { tenantId, userId, db },
);
```

Resolution layers (low → high): code seed → app rows → tenant rows
(hierarchy walk via an optional `tenantHierarchyLoader`; flat fallback
without `@happyvertical/smrt-users`) → user rows. A NULL column inherits
from the lower layer; resetting a customization is a row delete.

Writes are validated against the live `ObjectRegistry`: unknown
objects/fields are rejected, defaults are type-checked, and defaults on
`transient`/`sensitive`/`readPermission`-gated fields are refused. Required
fields can only be demoted from `basic` when a usable default resolves —
and the resolver re-enforces that invariant at read time.

See `AGENTS.md` for the full architecture notes.
