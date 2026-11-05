---
type: "Component"
title: "@happyvertical/smrt-dev-mcp"
description: "Development MCP server for SMRT framework knowledge, review context, architecture context, and code generation"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T15:48:19Z"
audience: "internal"
evidence_level: "manifest-described"
source_revision: "sha256:a01eccec517d6947a1a35bb4e970a7e9696bbfde005f068ea4ea31a431326706"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/smrt-dev-mcp/package.json"
    title: "@happyvertical/smrt-dev-mcp package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/smrt-dev-mcp/AGENTS.md"
    title: "@happyvertical/smrt-dev-mcp packages/smrt-dev-mcp/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/smrt-dev-mcp/agents/intent-duplicates.md"
    title: "@happyvertical/smrt-dev-mcp packages/smrt-dev-mcp/agents/intent-duplicates.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/smrt-dev-mcp/agents/protocol-conformance.md"
    title: "@happyvertical/smrt-dev-mcp packages/smrt-dev-mcp/agents/protocol-conformance.md"
---

# @happyvertical/smrt-dev-mcp

## Package

- Directory: `packages/smrt-dev-mcp`
- Private: no
- Object source: `none`
- Evidence level: `manifest-described`

## Documentation

- `packages/smrt-dev-mcp/AGENTS.md`
- `packages/smrt-dev-mcp/agents/intent-duplicates.md`
- `packages/smrt-dev-mcp/agents/protocol-conformance.md`

## Framework dependencies

- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-scanner](/components/smrt-scanner.md)
- [smrt-types](/components/smrt-types.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./dev-plane`
- `./knowledge`
- `./runtime`
- `./schemas/agent-plugins-1.0.0/mcp.schema.json`
- `./schemas/agent-plugins-1.0.0/plugin.schema.json`
