---
type: "Component"
title: "@happyvertical/smrt-tenancy"
description: "Production-ready multi-tenancy framework for SMRT with automatic tenant isolation and enforcement"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:ac11085876bd38b5f4cc84733d97f1cf9451ab9ad2e75f87c3542b9095d7b85e"
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

- Version: `0.60.8`
- Directory: `packages/tenancy`
- Private: no
- Object source: `domain-artifact`
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
- `./manifest`
- `./manifest.json`
- `./playground`
- `./svelte`
- `./testing`
- `./ui`

## Models

- `BillingRelationship` (collection `billingrelationships`, extends `SmrtObject`)
- `BillingRelationshipCollection` (collection `billingrelationships`, extends `SmrtCollection`)
