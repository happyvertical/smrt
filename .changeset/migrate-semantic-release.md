---
'@happyvertical/smrt': patch
---

feat(ci): migrate to semantic-release for automated versioning

Replaces changesets with semantic-release for fully automated versioning based on conventional commits.

**Version Bump Rules:**
- Breaking changes (`feat!:`, `BREAKING CHANGE:`) → minor bump (0.x.0)
- Features, fixes, performance (`feat:`, `fix:`, `perf:`) → patch bump (0.0.x)
- Docs, chores, refactors → no version bump

**Benefits:**
- No manual changeset files needed
- Automatic CHANGELOG.md generation
- Direct publish on merge (2 test runs vs 3)
- Versions determined from commit messages

**Safeguards:**
- Blocks publishing if version ≥ 1.0.0
- Breaking changes only bump minor (keeps 0.x.x)
- Manual coordination required for 1.0.0
