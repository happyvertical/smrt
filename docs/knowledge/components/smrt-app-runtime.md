---
type: "Component"
title: "@happyvertical/smrt-app-runtime"
description: "Validated local, self-hosted, and cloud runtime composition for s-m-r-t applications"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-09T05:13:39Z"
audience: "internal"
evidence_level: "manifest-described"
source_revision: "sha256:b69e93c6ec9f36acf27bd47f6022cce9519f1d1dfa2c6a2b0da5472fe4bbb9cf"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-runtime/package.json"
    title: "@happyvertical/smrt-app-runtime package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-runtime/AGENTS.md"
    title: "@happyvertical/smrt-app-runtime packages/app-runtime/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-runtime/README.md"
    title: "@happyvertical/smrt-app-runtime packages/app-runtime/README.md"
---

# @happyvertical/smrt-app-runtime

## Package

- Directory: `packages/app-runtime`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `manifest-described`

## Documentation

- `packages/app-runtime/AGENTS.md`
- `packages/app-runtime/README.md`

## Framework dependencies

- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-profiles](/components/smrt-profiles.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/encryption`
- `@happyvertical/sql`

## Exports

- `.`
- `./device-entitlements`
- `./sveltekit`
- `./sveltekit-runtime`
- `./vault-device-key`
- `./vault-key-generation`
- `./vault-recovery`
