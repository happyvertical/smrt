---
type: "Component"
title: "@happyvertical/smrt-social"
description: "Social media account management for multi-platform publishing in the SMRT ecosystem"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:08:46Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:096e70dbafce88c4379b58fdc00ecbba800660396d66ffabc738ea80c3e7459c"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/social/package.json"
    title: "@happyvertical/smrt-social package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/social/AGENTS.md"
    title: "@happyvertical/smrt-social packages/social/AGENTS.md"
---

# @happyvertical/smrt-social

## Package

- Directory: `packages/social`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/social/AGENTS.md`

## Framework dependencies

- [smrt-config](/components/smrt-config.md)
- [smrt-content](/components/smrt-content.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-secrets](/components/smrt-secrets.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-video](/components/smrt-video.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./server`
- `./svelte`

## Models

- `OAuthState` (collection `oauthstates`, extends `SmrtObject`, STI table)
- `SocialAccount` (collection `socialaccounts`, extends `SmrtObject`, STI table)
- `SocialPost` (collection `socialposts`, extends `SmrtObject`, STI table)
- `SocialPostAnalyticsSnapshot` (collection `socialpostanalyticssnapshots`, extends `SmrtObject`, STI table)

## MCP tools

- `get_socialaccounts`: get on `@happyvertical/smrt-social:SocialAccount`
- `get_socialpostanalyticssnapshots`: get on `@happyvertical/smrt-social:SocialPostAnalyticsSnapshot`
- `get_socialposts`: get on `@happyvertical/smrt-social:SocialPost`
- `list_socialaccounts`: list on `@happyvertical/smrt-social:SocialAccount`
- `list_socialpostanalyticssnapshots`: list on `@happyvertical/smrt-social:SocialPostAnalyticsSnapshot`
- `list_socialposts`: list on `@happyvertical/smrt-social:SocialPost`
