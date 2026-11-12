---
type: "Component"
title: "@happyvertical/smrt-preferences"
description: "Tenant defaults and per-user overrides for user-interface preferences (overview layouts, shell layout), validated per registered kind"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-12T05:12:16Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:504516753ec18b8f7f6e3ae827d17189f4d482377e371101f632a17dd8dee9aa"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/preferences/package.json"
    title: "@happyvertical/smrt-preferences package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/preferences/AGENTS.md"
    title: "@happyvertical/smrt-preferences packages/preferences/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/preferences/agents/preference-kinds.md"
    title: "@happyvertical/smrt-preferences packages/preferences/agents/preference-kinds.md"
---

# @happyvertical/smrt-preferences

## Package

- Directory: `packages/preferences`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/preferences/AGENTS.md`
- `packages/preferences/agents/preference-kinds.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-inference](/components/smrt-inference.md)
- [smrt-svelte](/components/smrt-svelte.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`

## Models

- `UiPreferenceRecord` (collection `uipreferencerecords`, extends `SmrtObject`)
- `UiPreferenceRecordCollection` (collection `uipreferencerecords`, extends `SmrtCollection`)
