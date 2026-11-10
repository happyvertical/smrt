---
type: "Component"
title: "@happyvertical/smrt-reactions"
description: "Tenant-scoped reactions and lightweight polls with shared participation enforcement"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:08:46Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:ed3f4ab372aac5c5e67a018c951b42e1c538faa1c132b6e879fd5b336e1806a7"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/reactions/package.json"
    title: "@happyvertical/smrt-reactions package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/reactions/AGENTS.md"
    title: "@happyvertical/smrt-reactions packages/reactions/AGENTS.md"
---

# @happyvertical/smrt-reactions

## Package

- Directory: `packages/reactions`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/reactions/AGENTS.md`

## Framework dependencies

- [smrt-comments](/components/smrt-comments.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./server`
- `./svelte`

## Models

- `Poll` (collection `polls`, extends `SmrtPolymorphicAssociation`)
- `PollVote` (collection `pollvotes`, extends `SmrtObject`)
- `Reaction` (collection `reactions`, extends `SmrtPolymorphicAssociation`)
