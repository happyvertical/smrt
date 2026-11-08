---
type: "Component"
title: "@happyvertical/smrt-personas"
description: "Tenant-owned, context-scoped agent personas and resolution for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T08:57:02Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:7172af7274cf4543e2a502e3bd413a10ed8e534d71a4a9137ef7628d10c3b2f1"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/personas/package.json"
    title: "@happyvertical/smrt-personas package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/personas/AGENTS.md"
    title: "@happyvertical/smrt-personas packages/personas/AGENTS.md"
---

# @happyvertical/smrt-personas

## Package

- Directory: `packages/personas`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/personas/AGENTS.md`

## Framework dependencies

- [smrt-agents](/components/smrt-agents.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-messages](/components/smrt-messages.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./svelte`

## Models

- `AgentPersona` (collection `agentpersonas`, extends `SmrtObject`)
- `AgentPersonaCollection` (collection `agentpersonas`, extends `SmrtCollection`)
- `DirectiveProposal` (collection `directiveproposals`, extends `SmrtObject`)
- `DirectiveProposalCollection` (collection `directiveproposals`, extends `SmrtCollection`)
- `Feedback` (collection `feedbacks`, extends `SmrtObject`)
- `FeedbackCollection` (collection `feedbacks`, extends `SmrtCollection`)

## MCP tools

- `agentpersona_get`: get on `@happyvertical/smrt-personas:AgentPersona`
- `agentpersona_list`: list on `@happyvertical/smrt-personas:AgentPersona`
- `directiveproposal_get`: get on `@happyvertical/smrt-personas:DirectiveProposal`
- `directiveproposal_list`: list on `@happyvertical/smrt-personas:DirectiveProposal`
- `feedback_get`: get on `@happyvertical/smrt-personas:Feedback`
- `feedback_list`: list on `@happyvertical/smrt-personas:Feedback`
