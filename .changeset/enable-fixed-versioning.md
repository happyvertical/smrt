---
'@happyvertical/smrt-core': patch
---

feat(ci): enable fixed versioning for workspace packages

Configure monorepo for fixed versioning where all workspace packages share the same version number.
Any change to the repository will bump all packages together. The root package.json version
will be manually kept in sync with the workspace packages.
