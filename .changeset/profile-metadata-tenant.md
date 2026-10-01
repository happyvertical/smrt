---
'@happyvertical/smrt-profiles': patch
---

Profile metadata carries its profile's tenant (#3235). `Profile.addMetadata()`
now stamps new `ProfileMetadata` rows with the profile's `tenantId` instead of
relying on tenant auto-population, which is skipped under a super-admin bypass
or system context, and heals a NULL-tenant row on its next update. The
`ProfileMetadata` and `ProfileMetafield` constructors keep an explicit
`tenantId` option (it was dropped by the class-field initializer), and metafield
lookups in `addMetadata()` / `removeMetadata()` prefer the profile tenant's
definition, then a global one, never another tenant's.
