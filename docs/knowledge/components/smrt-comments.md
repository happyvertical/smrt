---
type: "Component"
title: "@happyvertical/smrt-comments"
description: "Record comments and mention hooks for SMRT applications"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:bea41d337ef8aa84728deadfcf540568271a46707837c983bca22624443c0d5b"
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

- Version: `0.60.8`
- Directory: `packages/comments`
- Private: no
- Object source: `domain-artifact`
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
- `CommentCollection` (collection `comments`, extends `SmrtCollection`)
- `CommentReport` (collection `commentreports`, extends `SmrtObject`)
- `CommentReportCollection` (collection `commentreports`, extends `SmrtCollection`)
- `CommentRevision` (collection `commentrevisions`, extends `SmrtObject`)
- `CommentRevisionCollection` (collection `commentrevisions`, extends `SmrtCollection`)
- `ParticipationBan` (collection `participationbans`, extends `SmrtObject`)
- `ParticipationBanCollection` (collection `participationbans`, extends `SmrtCollection`)
- `ParticipationPolicy` (collection `participationpolicies`, extends `SmrtObject`)
- `ParticipationPolicyCollection` (collection `participationpolicies`, extends `SmrtCollection`)
- `ParticipationRateBucket` (collection `participationratebuckets`, extends `SmrtObject`)
- `ParticipationRateBucketCollection` (collection `participationratebuckets`, extends `SmrtCollection`)
