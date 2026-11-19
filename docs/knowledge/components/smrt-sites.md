---
type: "Component"
title: "@happyvertical/smrt-sites"
description: "Site lifecycle management for multi-tenant SMRT networks"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-19T13:59:13Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:8bc7559e1898a334956b83ce0ae845740cfeab75280f08b3161144b6a42c949e"
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
- `./hostname`
- `./manifest`
- `./manifest.json`

## Models

- `DnsZone` (collection `dnszones`, extends `SmrtObject`)
- `Domain` (collection `domains`, extends `SmrtObject`)
- `ProjectDomain` (collection `projectdomains`, extends `SmrtObject`)
- `ProjectDomainCollection` (collection `projectdomaincollections`, extends `SmrtJunction`)
- `Site` (collection `sites`, extends `SmrtObject`)
- `SiteAgentBinding` (collection `siteagentbindings`, extends `SmrtObject`)

## MCP tools

- `create_projectdomaincollections`: create on `@happyvertical/smrt-sites:ProjectDomainCollection`
- `create_sites`: create on `@happyvertical/smrt-sites:Site`
- `delete_projectdomaincollections`: delete on `@happyvertical/smrt-sites:ProjectDomainCollection`
- `get_dnszones`: get on `@happyvertical/smrt-sites:DnsZone`
- `get_domains`: get on `@happyvertical/smrt-sites:Domain`
- `get_projectdomaincollections`: get on `@happyvertical/smrt-sites:ProjectDomainCollection`
- `get_projectdomains`: get on `@happyvertical/smrt-sites:ProjectDomain`
- `get_siteagentbindings`: get on `@happyvertical/smrt-sites:SiteAgentBinding`
- `get_sites`: get on `@happyvertical/smrt-sites:Site`
- `list_dnszones`: list on `@happyvertical/smrt-sites:DnsZone`
- `list_domains`: list on `@happyvertical/smrt-sites:Domain`
- `list_projectdomaincollections`: list on `@happyvertical/smrt-sites:ProjectDomainCollection`
- `list_projectdomains`: list on `@happyvertical/smrt-sites:ProjectDomain`
- `list_siteagentbindings`: list on `@happyvertical/smrt-sites:SiteAgentBinding`
- `list_sites`: list on `@happyvertical/smrt-sites:Site`
- `update_projectdomaincollections`: update on `@happyvertical/smrt-sites:ProjectDomainCollection`
- `update_sites`: update on `@happyvertical/smrt-sites:Site`
