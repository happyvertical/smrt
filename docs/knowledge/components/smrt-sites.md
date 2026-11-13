---
type: "Component"
title: "@happyvertical/smrt-sites"
description: "Site lifecycle management for multi-tenant SMRT networks"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-13T15:36:07Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:fc63b2a26e980c8463008e3839f1e5fbe7a4d9bdd4b876e515e205ce0e7ed81f"
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

- `DnsZone` (collection `dnszones`, extends `SmrtObject`)
- `DnsZoneCollection` (collection `dnszones`, extends `SmrtCollection`)
- `Domain` (collection `domains`, extends `SmrtObject`)
- `DomainCollection` (collection `domains`, extends `SmrtCollection`)
- `ProjectDomain` (collection `projectdomains`, extends `SmrtObject`)
- `ProjectDomainCollection` (collection `projectdomains`, extends `SmrtJunction`)
- `Site` (collection `sites`, extends `SmrtObject`)
- `SiteAgentBinding` (collection `siteagentbindings`, extends `SmrtObject`)
- `SiteAgentBindingCollection` (collection `siteagentbindings`, extends `SmrtCollection`)
- `SiteCollection` (collection `sites`, extends `SmrtCollection`)

## MCP tools

- `dnszone_get`: get on `@happyvertical/smrt-sites:DnsZone`
- `dnszone_list`: list on `@happyvertical/smrt-sites:DnsZone`
- `domain_get`: get on `@happyvertical/smrt-sites:Domain`
- `domain_list`: list on `@happyvertical/smrt-sites:Domain`
- `projectdomain_get`: get on `@happyvertical/smrt-sites:ProjectDomain`
- `projectdomain_list`: list on `@happyvertical/smrt-sites:ProjectDomain`
- `site_create`: create on `@happyvertical/smrt-sites:Site`
- `site_get`: get on `@happyvertical/smrt-sites:Site`
- `site_list`: list on `@happyvertical/smrt-sites:Site`
- `site_update`: update on `@happyvertical/smrt-sites:Site`
- `siteagentbinding_get`: get on `@happyvertical/smrt-sites:SiteAgentBinding`
- `siteagentbinding_list`: list on `@happyvertical/smrt-sites:SiteAgentBinding`
