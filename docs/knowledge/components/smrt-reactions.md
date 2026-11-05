---
type: "Component"
title: "@happyvertical/smrt-reactions"
description: "Tenant-scoped reactions and lightweight polls with shared participation enforcement"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:a4048cfe59c9f1faf353be8f7d4bfd8c073225a4b13e091f1cb8c4ae1abf3935"
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

- Version: `0.60.8`
- Directory: `packages/reactions`
- Private: no
- Object source: `domain-artifact`
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
- `PollCollection` (collection `polls`, extends `SmrtCollection`)
- `PollVote` (collection `pollvotes`, extends `SmrtObject`)
- `PollVoteCollection` (collection `pollvotes`, extends `SmrtCollection`)
- `Reaction` (collection `reactions`, extends `SmrtPolymorphicAssociation`)
- `ReactionCollection` (collection `reactions`, extends `SmrtCollection`)
