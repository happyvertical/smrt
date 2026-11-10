---
type: "Component"
title: "@happyvertical/smrt-comments"
description: "Record comments and mention hooks for SMRT applications"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T02:12:11Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:628572c28e53ba1ae032d023142dc1ca8d204abe15804d6e6558013f6c049b8b"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/comments/package.json"
    title: "@happyvertical/smrt-comments package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/comments/AGENTS.md"
    title: "@happyvertical/smrt-comments packages/comments/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/comments/agents/idempotent-create.md"
    title: "@happyvertical/smrt-comments packages/comments/agents/idempotent-create.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/comments/agents/test-design.md"
    title: "@happyvertical/smrt-comments packages/comments/agents/test-design.md"
---

# @happyvertical/smrt-comments

## Package

- Directory: `packages/comments`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/comments/AGENTS.md`
- `packages/comments/agents/idempotent-create.md`
- `packages/comments/agents/test-design.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-messages](/components/smrt-messages.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./participation`
- `./svelte`

## Models

- `Comment` (collection `comments`, extends `SmrtPolymorphicAssociation`)
- `CommentReport` (collection `commentreports`, extends `SmrtObject`)
- `CommentRevision` (collection `commentrevisions`, extends `SmrtObject`)
- `ParticipationBan` (collection `participationbans`, extends `SmrtObject`)
- `ParticipationPolicy` (collection `participationpolicies`, extends `SmrtObject`)
- `ParticipationRateBucket` (collection `participationratebuckets`, extends `SmrtObject`)
