---
type: "Component"
title: "@happyvertical/smrt-personas"
description: "Tenant-owned, context-scoped agent personas and resolution for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T19:39:45Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:099b9b26bd3886fbc52ab7aa0d5e8356cc8374067e7b5360af1e5a4363de26da"
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
- Object source: `scanner`
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
- `DirectiveProposal` (collection `directiveproposals`, extends `SmrtObject`)
- `Feedback` (collection `feedbacks`, extends `SmrtObject`)

## MCP tools

- `get_agentpersonas`: get on `@happyvertical/smrt-personas:AgentPersona`
- `get_directiveproposals`: get on `@happyvertical/smrt-personas:DirectiveProposal`
- `get_feedbacks`: get on `@happyvertical/smrt-personas:Feedback`
- `list_agentpersonas`: list on `@happyvertical/smrt-personas:AgentPersona`
- `list_directiveproposals`: list on `@happyvertical/smrt-personas:DirectiveProposal`
- `list_feedbacks`: list on `@happyvertical/smrt-personas:Feedback`
