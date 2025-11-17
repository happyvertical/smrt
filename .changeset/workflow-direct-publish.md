---
'@happyvertical/smrt-core': patch
---

fix(ci): skip changeset check for automated Version Packages PRs

Align with SDK direct publish pattern to prevent changeset checks on automated
Version Packages PRs. This reduces CI overhead by eliminating unnecessary test runs.
