---
'@happyvertical/smrt-core': minor
---

**Release C — collision-policy decision table + strict-mode default + retire SKIP_STI_REHYDRATE (#1134)**

Third and final release of the ObjectRegistry / SmrtObject review thread.

**Internal refactor (no consumer API change):**

- `register()` and `registerFromManifest()` now share a single 16-row decision table at `packages/core/src/registry/collision-policy.ts`. The 11-branch exact-match + case-insensitive collision tree in `register()` and the 3-branch `resolveManifestCollision()` it mirrored are all collapsed onto `decideCollisionPolicy()`. Every row corresponds to a named scenario (`manifest-stub-replacement`, `sti-child-wins`, `decorator-case-insensitive-pnpm-duplicate`, etc.) that maps 1:1 to the existing issue-specific test suite (#531, #555, #584, #847, #950, #951, #1000). `resolveManifestCollision()` is deleted.

**Breaking changes (minor):**

- **`SMRT_STRICT_REGISTRY` is now on by default.** Severity-`'error'` diagnostics throw at record time instead of being silently collected. Affected codes: `MANIFEST_EXPORT_INVALID`, `MANIFEST_EXPORT_NOT_JSON`, `MANIFEST_EXPORT_NOT_FOUND`, `PACKAGE_MANIFEST_READ_FAILED`. Warn-severity codes are unchanged. To restore the pre-Release-C permissive behavior set `SMRT_STRICT_REGISTRY=false`.
- **`SMRT_SKIP_STI_REHYDRATE` removed.** The env flag disappears. PR #1131's unconditional STI descendant rehydration on save is now the only behavior, preserving the stale-cache repair contract from `external-runtime-hydration.test.ts:1071`. Further optimizing the loop away is tracked in [#1139](https://github.com/happyvertical/smrt/issues/1139).
- Collision error messages carry a stable scenario identifier in the verbose-log output. Text in end-user `throw` messages is unchanged.

**Migration:**
- Run your test suite with the new default. If `MANIFEST_EXPORT_*` or `PACKAGE_MANIFEST_READ_FAILED` start throwing, the underlying manifest misconfiguration is the thing to fix; if you genuinely need to keep shipping despite a broken manifest, set `SMRT_STRICT_REGISTRY=false` in your runtime env.
- Remove any `SMRT_SKIP_STI_REHYDRATE=true` setting from your env; it's now a no-op.
