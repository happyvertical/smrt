---
type: Capability
title: "Secrets and configuration"
description: "Reach for smrt-secrets for per-tenant encrypted secrets and smrt-config for application configuration instead of raw env reads and ad-hoc encryption."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-4687
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/secrets/src/services/SecretService.ts
    path: packages/secrets/src/services/SecretService.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/secrets/src/services/SecretService.ts (SecretService.store)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/secrets/src/index.ts
    path: packages/secrets/src/index.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/secrets/src/index.ts (public exports)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/config/src/loaded-config.ts
    path: packages/config/src/loaded-config.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/config/src/loaded-config.ts (globalThis.__smrtConfigCache)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/config/src/index.ts
    path: packages/config/src/index.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/config/src/index.ts (loadConfig)"
---

# Secrets and configuration

# Entry point

Secrets: `SecretService.create({ db, ... })` from `@happyvertical/smrt-secrets`, then `store(name, value, { description, category, expiresAt })` inside a tenant context (`storeForTenant()` outside one). Values are envelope-encrypted by the @happyvertical/secrets store under a per-tenant data key, and key drift is diagnosed with `diagnoseTenantSecretKeyDrift()`. Config: `await loadConfig()` once at startup (finds `smrt.config.*`), then `getConfig()`, `getModuleConfig()` or `getPackageConfig()` from `@happyvertical/smrt-config`; `defineConfig()` types the file.[^s2][^s4]

# Why not hand-roll it

`SecretService.store()` in `SecretService.ts` looks the secret up for the current tenant only (an unscoped lookup once found another tenant's same-named row and overwrote it with an envelope encrypted under the wrong key, #1501), refuses to save over a foreign row even if a lookup regresses, keys the upsert on slug plus `context = tenantId` so tenants can reuse names, and writes a `SecretAuditLog` row for create, update and failure alike, classifying tenant-key failures.[^s1] For config, `loaded-config.ts` keeps the parsed config on `globalThis.__smrtConfigCache` so every module instance, including pnpm workspace packages loaded from different paths, sees the same object.[^s3] Raw `process.env` reads and home-made AES have no tenant boundary, rotation or audit trail.

# Component pages

- [smrt-secrets](/components/smrt-secrets.md)
- [smrt-config](/components/smrt-config.md)

# Detection signals

- `import:dotenv`
- `import:node-vault`
- `import:cosmiconfig`
- `import:convict`
- `regex:process\.env\.\w*SECRET`
- `regex:createCipheriv\(`

[^s1]: `packages/secrets/src/services/SecretService.ts` at `478ae36900`: SecretService.store.
[^s2]: `packages/secrets/src/index.ts` at `478ae36900`: public exports.
[^s3]: `packages/config/src/loaded-config.ts` at `478ae36900`: globalThis.__smrtConfigCache.
[^s4]: `packages/config/src/index.ts` at `478ae36900`: loadConfig.
