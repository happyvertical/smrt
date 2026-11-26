---
type: "Component"
title: "@happyvertical/smrt-agents"
description: "Agent framework for building autonomous actors in the SMRT ecosystem"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-26T17:21:08Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:985dbc4c17868e21ca10c80b95ba8bcc71070ca8a1b1cf8b3a648f602fd0ae3a"
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
  - id: "agents-5"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/agents/agents/principal-binding.md"
    title: "@happyvertical/smrt-agents packages/agents/agents/principal-binding.md"
---

# @happyvertical/smrt-agents

## Package

- Directory: `packages/agents`
- Private: no
- Object source: `manifest`
- Evidence level: `source-inspected`

## Documentation

- `packages/agents/AGENTS.md`
- `packages/agents/agents/data-surface-denials.md`
- `packages/agents/agents/data-surface-discovery.md`
- `packages/agents/agents/lazy-config.md`
- `packages/agents/agents/principal-binding.md`

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
- `TenantAgent` (collection `tenantagents`, extends `SmrtObject`)
- `TenantAgentCollection` (collection `tenantagents`, extends `SmrtCollection`)

## MCP tools

- `create_agentconfigs`: create on `@happyvertical/smrt-agents:AgentConfigCollection`
- `create_agentschedules`: create on `@happyvertical/smrt-agents:AgentScheduleCollection`
- `create_tenantagents`: create on `@happyvertical/smrt-agents:TenantAgentCollection`
- `delete_agentconfigs`: delete on `@happyvertical/smrt-agents:AgentConfigCollection`
- `delete_agentschedules`: delete on `@happyvertical/smrt-agents:AgentScheduleCollection`
- `delete_tenantagents`: delete on `@happyvertical/smrt-agents:TenantAgentCollection`
- `get_agentconfigs`: get on `@happyvertical/smrt-agents:AgentConfig`
- `get_agentconfigs`: get on `@happyvertical/smrt-agents:AgentConfigCollection`
- `get_agentschedules`: get on `@happyvertical/smrt-agents:AgentSchedule`
- `get_agentschedules`: get on `@happyvertical/smrt-agents:AgentScheduleCollection`
- `get_tenantagents`: get on `@happyvertical/smrt-agents:TenantAgent`
- `get_tenantagents`: get on `@happyvertical/smrt-agents:TenantAgentCollection`
- `list_agentconfigs`: list on `@happyvertical/smrt-agents:AgentConfig`
- `list_agentconfigs`: list on `@happyvertical/smrt-agents:AgentConfigCollection`
- `list_agentschedules`: list on `@happyvertical/smrt-agents:AgentSchedule`
- `list_agentschedules`: list on `@happyvertical/smrt-agents:AgentScheduleCollection`
- `list_tenantagents`: list on `@happyvertical/smrt-agents:TenantAgent`
- `list_tenantagents`: list on `@happyvertical/smrt-agents:TenantAgentCollection`
- `update_agentconfigs`: update on `@happyvertical/smrt-agents:AgentConfigCollection`
- `update_agentschedules`: update on `@happyvertical/smrt-agents:AgentScheduleCollection`
- `update_tenantagents`: update on `@happyvertical/smrt-agents:TenantAgentCollection`
