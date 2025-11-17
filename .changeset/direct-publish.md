---
'@happyvertical/smrt': patch
---

feat(ci): implement direct publish on merge to main

Removes the intermediate "Version Packages" PR step to reduce CI overhead. The workflow now:
- Versions packages directly when merged to main
- Publishes immediately after versioning
- Commits version changes back to main automatically
- **Validates against major version bumps** - prevents accidental 1.0.0+ releases

This reduces test runs from 3 to 2 per PR while maintaining changeset-based versioning and changelog generation.

The workflow includes safeguards to block major version releases, requiring manual coordination for 1.0.0+ versions.
