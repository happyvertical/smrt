---
'@happyvertical/smrt-projects': patch
---

`Repository.createIssue()` / `createPullRequest()` no longer copy any of the
repository's own columns (`id`, `slug`, `created_at`, its other fields) into
the new issue when the repository was loaded from the database, so each
created issue is its own row instead of overwriting the previous one. The
repository's tenant still carries over.
