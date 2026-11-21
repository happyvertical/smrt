---
type: "Component"
title: "@happyvertical/smrt-tenancy"
description: "Production-ready multi-tenancy framework for SMRT with automatic tenant isolation and enforcement"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-21T10:47:34Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:06fd604495743768b3e0d01158dcfb341e92d54b7e32dc88985fc59ff3fbc192"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/tenancy/package.json"
    title: "@happyvertical/smrt-tenancy package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/tenancy/AGENTS.md"
    title: "@happyvertical/smrt-tenancy packages/tenancy/AGENTS.md"
---

# @happyvertical/smrt-tenancy

## Package

- Directory: `packages/tenancy`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/tenancy/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./adapters`
- `./decorators`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./svelte`
- `./testing`
- `./ui`

## Models

- `BillingRelationship` (collection `billingrelationships`, extends `SmrtObject`)
