---
'@happyvertical/smrt-projects': patch
---

`Repository.createIssue()` / `createPullRequest()` no longer copy the
repository's own `id`/`slug` into the new issue when the repository was loaded
from the database, so each created issue is its own row instead of
overwriting the previous one.
