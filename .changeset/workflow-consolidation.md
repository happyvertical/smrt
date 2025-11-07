---
"@happyvertical/smrt": patch
---

Optimize workflow with auto-merge, cascade triggers, and eliminate redundant builds

- Added auto-merge for changesets version PRs when CI passes
- Added git tag creation for published packages
- Added cascade trigger to praeco after publishing
- Removed redundant build step from release job (test job already builds)
- Changed deploy-docs dependency from release to test (parallel execution)
