---
'@happyvertical/smrt-core': patch
---

feat(ci): use shared direct publish workflow from SDK

Migrate to the shared-direct-publish.yml reusable workflow from SDK for consistent
publishing across all HappyVertical repositories. This eliminates intermediate
"Version Packages" PRs and reduces CI runs from 3 to 2 per feature PR cycle.

Changes:
- Replace changesets/action@v1 with SDK's shared workflow
- Separate cascade job for dependency triggers
- Consistent with SDK's direct publish pattern
