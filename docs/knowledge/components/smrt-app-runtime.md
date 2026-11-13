---
type: "Component"
title: "@happyvertical/smrt-app-runtime"
description: "Validated local, self-hosted, and cloud runtime composition for s-m-r-t applications"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-13T18:28:13Z"
audience: "internal"
evidence_level: "manifest-described"
source_revision: "sha256:453d5706694d1afc85d4808d53eb7d1b82310bcc8baf9a3e8a81ac3953695bdc"
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
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-runtime/agents/local-schema.md"
    title: "@happyvertical/smrt-app-runtime packages/app-runtime/agents/local-schema.md"
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
- `packages/app-runtime/agents/local-schema.md`

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
- `./vault-device-transfer`
- `./vault-key-generation`
- `./vault-key-lifecycle`
- `./vault-key-store`
- `./vault-recovery`
