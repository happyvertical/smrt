---
'@happyvertical/smrt': patch
---

feat(ci): enable fixed versioning with root package included

Configure monorepo for fixed versioning where all packages share the same version number.
Any change to the repository will bump all packages together, with the root package.json
as the single source of truth.
