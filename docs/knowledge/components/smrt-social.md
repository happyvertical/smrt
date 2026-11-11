---
type: "Component"
title: "@happyvertical/smrt-social"
description: "Social media account management for multi-platform publishing in the SMRT ecosystem"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-11T06:56:27Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:4b0ca636bd5e842573f54ed89143b1ae0a200da0c2980ffbf106d6fba1b3e658"
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
- Object source: `domain-artifact`
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
- `OAuthStateCollection` (collection `oauthstates`, extends `SmrtCollection`)
- `SocialAccount` (collection `socialaccounts`, extends `SmrtObject`, STI table)
- `SocialAccountCollection` (collection `socialaccounts`, extends `SmrtCollection`)
- `SocialPost` (collection `socialposts`, extends `SmrtObject`, STI table)
- `SocialPostAnalyticsSnapshot` (collection `socialpostanalyticssnapshots`, extends `SmrtObject`, STI table)
- `SocialPostAnalyticsSnapshotCollection` (collection `socialpostanalyticssnapshots`, extends `SmrtCollection`)
- `SocialPostCollection` (collection `socialposts`, extends `SmrtCollection`)

## MCP tools

- `socialaccount_get`: get on `@happyvertical/smrt-social:SocialAccount`
- `socialaccount_list`: list on `@happyvertical/smrt-social:SocialAccount`
- `socialpost_get`: get on `@happyvertical/smrt-social:SocialPost`
- `socialpost_list`: list on `@happyvertical/smrt-social:SocialPost`
- `socialpostanalyticssnapshot_get`: get on `@happyvertical/smrt-social:SocialPostAnalyticsSnapshot`
- `socialpostanalyticssnapshot_list`: list on `@happyvertical/smrt-social:SocialPostAnalyticsSnapshot`
