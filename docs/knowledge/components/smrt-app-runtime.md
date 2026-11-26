---
type: "Component"
title: "@happyvertical/smrt-app-runtime"
description: "Validated local, self-hosted, and cloud runtime composition for s-m-r-t applications"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-26T17:59:34Z"
audience: "internal"
evidence_level: "manifest-described"
source_revision: "sha256:e5b013b79040002038a451219e0a6fa6ddb68eb3ee983a72471bdefa5990dc84"
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
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-runtime/agents/keychain-vault-key-store.md"
    title: "@happyvertical/smrt-app-runtime packages/app-runtime/agents/keychain-vault-key-store.md"
  - id: "agents-5"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-runtime/agents/local-schema.md"
    title: "@happyvertical/smrt-app-runtime packages/app-runtime/agents/local-schema.md"
  - id: "agents-6"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-runtime/agents/owner-approvals.md"
    title: "@happyvertical/smrt-app-runtime packages/app-runtime/agents/owner-approvals.md"
  - id: "agents-7"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-runtime/agents/self-issuer-mcp.md"
    title: "@happyvertical/smrt-app-runtime packages/app-runtime/agents/self-issuer-mcp.md"
  - id: "agents-8"
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
- `packages/app-runtime/agents/keychain-vault-key-store.md`
- `packages/app-runtime/agents/local-schema.md`
- `packages/app-runtime/agents/owner-approvals.md`
- `packages/app-runtime/agents/self-issuer-mcp.md`
- `packages/app-runtime/agents/windows-custody.md`

## Framework dependencies

- [smrt-app-mcp](/components/smrt-app-mcp.md)
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
