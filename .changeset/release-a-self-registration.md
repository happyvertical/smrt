---
'@happyvertical/smrt-core': minor
'@happyvertical/smrt-ads': patch
'@happyvertical/smrt-affiliates': patch
'@happyvertical/smrt-agents': patch
'@happyvertical/smrt-analytics': patch
'@happyvertical/smrt-assets': patch
'@happyvertical/smrt-chat': patch
'@happyvertical/smrt-commerce': patch
'@happyvertical/smrt-content': patch
'@happyvertical/smrt-events': patch
'@happyvertical/smrt-facts': patch
'@happyvertical/smrt-features': patch
'@happyvertical/smrt-images': patch
'@happyvertical/smrt-jobs': patch
'@happyvertical/smrt-ledgers': patch
'@happyvertical/smrt-messages': patch
'@happyvertical/smrt-places': patch
'@happyvertical/smrt-products': patch
'@happyvertical/smrt-profiles': patch
'@happyvertical/smrt-projects': patch
'@happyvertical/smrt-properties': patch
'@happyvertical/smrt-secrets': patch
'@happyvertical/smrt-sites': patch
'@happyvertical/smrt-social': patch
'@happyvertical/smrt-tags': patch
'@happyvertical/smrt-tenancy': patch
'@happyvertical/smrt-users': patch
'@happyvertical/smrt-video': patch
'@happyvertical/smrt-voice': patch
---

**Release A — close #1132: self-registering package manifests**

Consumer runtimes (tsx, SvelteKit SSR, plain `vite dev`) no longer silently drop declared model fields. Every `@happyvertical/smrt-*` domain package now loads its own build-time manifest as a top-of-entry side effect, so `@smrt()` decorators find their fields before any class module evaluates. `place.save()` / `list({ where: { externalId } })` now round-trip declared fields from a fresh `pnpm add @happyvertical/smrt-places` — no vitest plugin required.

**New in @happyvertical/smrt-core**:
- `ObjectRegistry.registerPackageManifest(url)` — the primitive each package calls at import time.
- `ObjectRegistry.getDiagnostics()` / `flushDiagnostics()` / `clearDiagnostics()` — opt-in collector for registry load failures that previously surfaced only as `console.warn`. Passive in this release; Release C (#1134) flips `SMRT_STRICT_REGISTRY` on by default.
- `SMRT_SKIP_STI_REHYDRATE=true` env flag — opts out of the unconditional STI descendant re-hydration added in #1131, now redundant for consumers on the new builds. The flag is removed in Release C (#1134) once the self-registration rollout is proven stable.

**Per-package change**: each listed package gains a one-line `src/__smrt-register__.ts` shim that runs before its class modules load. No consumer-facing API change.
