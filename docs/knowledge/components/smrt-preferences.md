---
type: "Component"
title: "@happyvertical/smrt-preferences"
description: "Tenant defaults and per-user overrides for user-interface preferences (overview layouts, shell layout), validated per registered kind"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-16T06:31:57Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:c32c3754f4aaf456f8aa58d7d75394b5f32bc9cc34ef60e47132a838f058605c"
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
- Object source: `scanner`
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
