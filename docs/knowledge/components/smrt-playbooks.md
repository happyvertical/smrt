---
type: "Component"
title: "@happyvertical/smrt-playbooks"
description: "Layered playbook registry, app/tenant overrides, and plan resolution for SMRT agents"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-17T18:54:39Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:b67d2d8fe69b781f9de58fc0b068190944194eaec991cff72c51f19aa8f22b10"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/playbooks/package.json"
    title: "@happyvertical/smrt-playbooks package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/playbooks/AGENTS.md"
    title: "@happyvertical/smrt-playbooks packages/playbooks/AGENTS.md"
---

# @happyvertical/smrt-playbooks

## Package

- Directory: `packages/playbooks`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/playbooks/AGENTS.md`

## Framework dependencies

- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`

## Models

- `PlaybookOverride` (collection `playbookoverrides`, extends `SmrtObject`)
