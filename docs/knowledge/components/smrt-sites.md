---
type: "Component"
title: "@happyvertical/smrt-sites"
description: "Site lifecycle management for multi-tenant SMRT networks"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:08:46Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:39eba3bc15bb7794ea7339877b1cccb323077a668fab08f226e00d1bc21c6859"
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

- Directory: `packages/sites`
- Private: no
- Object source: `scanner`
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

## MCP tools

- `create_sites`: create on `@happyvertical/smrt-sites:Site`
- `get_siteagentbindings`: get on `@happyvertical/smrt-sites:SiteAgentBinding`
- `get_sites`: get on `@happyvertical/smrt-sites:Site`
- `list_siteagentbindings`: list on `@happyvertical/smrt-sites:SiteAgentBinding`
- `list_sites`: list on `@happyvertical/smrt-sites:Site`
- `update_sites`: update on `@happyvertical/smrt-sites:Site`
