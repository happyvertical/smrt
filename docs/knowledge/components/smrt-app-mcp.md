---
type: "Component"
title: "@happyvertical/smrt-app-mcp"
description: "App-runtime MCP server scaffolding for SMRT apps — `createMcpAppServer` plus transport adapters (SvelteKit today) for exposing a SMRT app's MCP surface over HTTP."
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-21T22:51:06Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:70b3fb213285d6816ada71015710bdf1fff42cc24f28560c1957dcab4d90fe3a"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/smrt-app-mcp/package.json"
    title: "@happyvertical/smrt-app-mcp package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/smrt-app-mcp/AGENTS.md"
    title: "@happyvertical/smrt-app-mcp packages/smrt-app-mcp/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/smrt-app-mcp/agents/runtime-loading.md"
    title: "@happyvertical/smrt-app-mcp packages/smrt-app-mcp/agents/runtime-loading.md"
---

# @happyvertical/smrt-app-mcp

## Package

- Directory: `packages/smrt-app-mcp`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/smrt-app-mcp/AGENTS.md`
- `packages/smrt-app-mcp/agents/runtime-loading.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./audit-store`
- `./auth`
- `./host-operations`
- `./manifest`
- `./manifest.json`
- `./sveltekit`

## Models

- `McpCallAudit` (collection `mcpcallaudits`, extends `SmrtObject`)
- `McpCallAuditCollection` (collection `mcpcallaudits`, extends `SmrtCollection`)
