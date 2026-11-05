---
type: "Component"
title: "@happyvertical/smrt-preferences"
description: "Tenant defaults and per-user overrides for user-interface preferences (overview layouts, shell layout), validated per registered kind"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:1f34552267557375092b4839d84625433be730232d3eb0e93ae31749a847d759"
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

- Version: `0.60.8`
- Directory: `packages/preferences`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/preferences/AGENTS.md`
- `packages/preferences/agents/preference-kinds.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
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
