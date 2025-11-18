---
'@happyvertical/smrt-core': patch
---

fix(ci): remove GITHUB_TOKEN from workflow secrets

Remove GITHUB_TOKEN from publish.yml secrets since it's automatically
provided by GitHub Actions. Fixes 'secret name collision' errors.
