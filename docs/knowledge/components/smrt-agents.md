---
type: "Component"
title: "@happyvertical/smrt-agents"
description: "Agent framework for building autonomous actors in the SMRT ecosystem"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-09T01:37:22Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:fc8e7296ecc64285a7c8833ccfb392eeb869f0d02cd0253f3defe5629da337c4"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/agents/package.json"
    title: "@happyvertical/smrt-agents package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/agents/AGENTS.md"
    title: "@happyvertical/smrt-agents packages/agents/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/agents/agents/data-surface-denials.md"
    title: "@happyvertical/smrt-agents packages/agents/agents/data-surface-denials.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/agents/agents/data-surface-discovery.md"
    title: "@happyvertical/smrt-agents packages/agents/agents/data-surface-discovery.md"
  - id: "agents-4"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/agents/agents/lazy-config.md"
    title: "@happyvertical/smrt-agents packages/agents/agents/lazy-config.md"
---

# @happyvertical/smrt-agents

## Package

- Directory: `packages/agents`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/agents/AGENTS.md`
- `packages/agents/agents/data-surface-denials.md`
- `packages/agents/agents/data-surface-discovery.md`
- `packages/agents/agents/lazy-config.md`

## Framework dependencies

- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-playbooks](/components/smrt-playbooks.md)
- [smrt-reports](/components/smrt-reports.md)
- [smrt-secrets](/components/smrt-secrets.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/files`
- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./server`
- `./svelte`
- `./svelte/admin`
- `./ui`
- `./vite`

## Models

- `Agent` (collection `agents`, extends `SmrtObject`, STI table)
- `AgentConfig` (collection `agentconfigs`, extends `SmrtObject`)
- `AgentConfigCollection` (collection `agentconfigs`, extends `SmrtCollection`)
- `AgentSchedule` (collection `agentschedules`, extends `SmrtObject`)
- `AgentScheduleCollection` (collection `agentschedules`, extends `SmrtCollection`)
- `DataSurfaceActionIdempotencyState` (collection `datasurfaceactionidempotencystates`, extends `SmrtObject`)
- `DataSurfaceActionTokenState` (collection `datasurfaceactiontokenstates`, extends `SmrtObject`)
- `SmrtDataSurfaceActionTask` (collection `smrtdatasurfaceactiontasks`, extends `SmrtObject`)
- `TenantAgent` (collection `tenantagents`, extends `SmrtObject`)
- `TenantAgentCollection` (collection `tenantagents`, extends `SmrtCollection`)

## MCP tools

- `agentconfig_get`: get on `@happyvertical/smrt-agents:AgentConfig`
- `agentconfig_list`: list on `@happyvertical/smrt-agents:AgentConfig`
- `agentschedule_get`: get on `@happyvertical/smrt-agents:AgentSchedule`
- `agentschedule_list`: list on `@happyvertical/smrt-agents:AgentSchedule`
- `tenantagent_get`: get on `@happyvertical/smrt-agents:TenantAgent`
- `tenantagent_list`: list on `@happyvertical/smrt-agents:TenantAgent`
