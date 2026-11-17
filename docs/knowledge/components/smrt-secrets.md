---
type: "Component"
title: "@happyvertical/smrt-secrets"
description: "Per-tenant secret management with envelope encryption for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-17T17:27:50Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:4a4d419da62b3eda5c3112f51a22a8c996a2a6785501e5aba3635072d4a15231"
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
- Object source: `scanner`
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
- `./manifest`
- `./manifest.json`
- `./models`
- `./service`

## Models

- `Secret` (collection `secrets`, extends `SmrtObject`)
- `SecretAuditLog` (collection `secretauditlogs`, extends `SmrtObject`)
- `TenantKey` (collection `tenantkeys`, extends `SmrtObject`)
