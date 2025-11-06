---
"@happyvertical/smrt-cli": patch
---

fix(cli): support parameterless custom methods without `<id>` requirement

Methods with no parameters (like `praeco.research()` and `praeco.report()`) no longer incorrectly require an `<id>` argument in CLI commands.

**The Problem:**
All custom methods were hardcoded to require an `<id>` parameter:
```bash
npx smrt praeco:research <id>  # ❌ Error: requires ID but shouldn't
```

**The Solution:**
- Detects method parameter count from manifest (`methodDef.parameters.length`)
- If parameterless → no `<id>` arg → calls `handleSingletonMethod()`
- If has parameters → requires `<id>` arg → calls `handleCustomMethod()`

**New `handleSingletonMethod()`:**
- Creates fresh instance without database lookup
- Calls `initialize()` if available
- Executes method and returns JSON result

**Examples:**
```bash
npx smrt praeco:research  # ✅ Works now!
npx smrt praeco:report    # ✅ Works now!
npx smrt meeting:addDocument <id> <url>  # Still requires <id>
```

This enables replacing workflow TypeScript files with CLI commands in CI/CD:
```yaml
# Before: pnpm workflow:praeco
# After:
- run: npx smrt praeco:research
- run: npx smrt praeco:report
```

Fixes #221
