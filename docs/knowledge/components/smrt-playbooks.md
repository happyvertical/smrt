---
type: "Component"
title: "@happyvertical/smrt-playbooks"
description: "Layered playbook registry, app/tenant overrides, and plan resolution for SMRT agents"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T15:48:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:b774deb60a56b08fdae353257d9ca920cc04773ca9b53f580199cd0e6a8f184d"
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
- Object source: `domain-artifact`
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
- `PlaybookOverrideCollection` (collection `playbookoverrides`, extends `SmrtCollection`)
