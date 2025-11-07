---
"@happyvertical/smrt-accounts": patch
"@happyvertical/smrt-assets": patch
"@happyvertical/smrt-events": patch
"@happyvertical/smrt-gnode": patch
"@happyvertical/smrt-tags": patch
"@happyvertical/smrt-svelte": patch
"@happyvertical/smrt-docs-mcp": patch
---

Add --passWithNoTests flag to test scripts for packages without test files

Packages that don't yet have test files now use `vitest run --passWithNoTests` instead of `vitest run`, allowing CI to pass while we incrementally add tests. This fixes the test suite failures caused by vitest exiting with code 1 when no tests are found.
