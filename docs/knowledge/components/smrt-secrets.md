---
type: "Component"
title: "@happyvertical/smrt-secrets"
description: "Per-tenant secret management with envelope encryption for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-20T00:35:42Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:f46913fba811e97d33c34049f85ef39699815ffbda6d48a75909782b23755b64"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/secrets/package.json"
    title: "@happyvertical/smrt-secrets package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/secrets/AGENTS.md"
    title: "@happyvertical/smrt-secrets packages/secrets/AGENTS.md"
---

# @happyvertical/smrt-secrets

## Package

- Directory: `packages/secrets`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/secrets/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/logger`
- `@happyvertical/secrets`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./connect`
- `./manifest`
- `./manifest.json`
- `./models`
- `./service`

## Models

- `ConnectState` (collection `connectstates`, extends `SmrtObject`)
- `ConnectStateCollection` (collection `connectstates`, extends `SmrtCollection`)
- `Secret` (collection `secrets`, extends `SmrtObject`)
- `SecretAuditLog` (collection `secretauditlogs`, extends `SmrtObject`)
- `SecretAuditLogCollection` (collection `secretauditlogs`, extends `SmrtCollection`)
- `SecretCollection` (collection `secrets`, extends `SmrtCollection`)
- `TenantKey` (collection `tenantkeys`, extends `SmrtObject`)
- `TenantKeyCollection` (collection `tenantkeys`, extends `SmrtCollection`)
