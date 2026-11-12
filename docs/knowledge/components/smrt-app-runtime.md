---
type: "Component"
title: "@happyvertical/smrt-app-runtime"
description: "Validated local, self-hosted, and cloud runtime composition for s-m-r-t applications"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-12T04:46:15Z"
audience: "internal"
evidence_level: "manifest-described"
source_revision: "sha256:e1e18939bd9e2810853956c7ec9cf9bc5219954a1e0e1b6e928896079c6ccd51"
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
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-runtime/agents/desktop-signin.md"
    title: "@happyvertical/smrt-app-runtime packages/app-runtime/agents/desktop-signin.md"
  - id: "agents-4"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-runtime/agents/owner-approvals.md"
    title: "@happyvertical/smrt-app-runtime packages/app-runtime/agents/owner-approvals.md"
  - id: "agents-5"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-runtime/agents/windows-custody.md"
    title: "@happyvertical/smrt-app-runtime packages/app-runtime/agents/windows-custody.md"
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
- `packages/app-runtime/agents/desktop-signin.md`
- `packages/app-runtime/agents/owner-approvals.md`
- `packages/app-runtime/agents/windows-custody.md`

## Framework dependencies

- [smrt-approvals](/components/smrt-approvals.md)
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
