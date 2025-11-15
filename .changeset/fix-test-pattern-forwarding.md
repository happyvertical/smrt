---
"@happyvertical/smrt-cli": patch
---

fix(cli): forward file patterns to Vitest in test command

The `smrt test [pattern]` command now properly forwards file patterns to Vitest, enabling targeted test execution. Previously, all test files would run regardless of the pattern provided.

Fixes #309

**Before:**
```bash
smrt test Council.spec  # Ran all test files
```

**After:**
```bash
smrt test Council.spec  # Runs only Council.spec.ts
smrt test src/models/Council.spec.ts  # Runs specific file
```

**Performance Impact:**
- Single file: ~800ms (vs 181s for all files)
- Enables practical TDD workflow
