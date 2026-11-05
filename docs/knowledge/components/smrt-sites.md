---
type: "Component"
title: "@happyvertical/smrt-sites"
description: "Site lifecycle management for multi-tenant SMRT networks"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:48:43Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:755791c38edddab333c3184d62dac00c4b1360c343d11ab6978c386bbfea84a8"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/sites/package.json"
    title: "@happyvertical/smrt-sites package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/sites/AGENTS.md"
    title: "@happyvertical/smrt-sites packages/sites/AGENTS.md"
---

# @happyvertical/smrt-sites

## Package

- Version: `0.60.8`
- Directory: `packages/sites`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/sites/AGENTS.md`

## Framework dependencies

- [smrt-cli](/components/smrt-cli.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`

## Models

- `Site` (collection `sites`, extends `SmrtObject`)
- `SiteAgentBinding` (collection `siteagentbindings`, extends `SmrtObject`)
- `SiteAgentBindingCollection` (collection `siteagentbindings`, extends `SmrtCollection`)
- `SiteCollection` (collection `sites`, extends `SmrtCollection`)

## MCP tools

- `site_create`: create on `@happyvertical/smrt-sites:Site`
- `site_get`: get on `@happyvertical/smrt-sites:Site`
- `site_list`: list on `@happyvertical/smrt-sites:Site`
- `site_update`: update on `@happyvertical/smrt-sites:Site`
- `siteagentbinding_get`: get on `@happyvertical/smrt-sites:SiteAgentBinding`
- `siteagentbinding_list`: list on `@happyvertical/smrt-sites:SiteAgentBinding`
