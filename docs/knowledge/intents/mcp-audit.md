---
type: Capability
title: "Audit agent tool calls"
description: "Reach for the smrt-app-mcp auditSink and the McpCallAudit store before writing a request log for agent tool calls."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-5083
  at: 2026-11-17T00:00:00Z
stale_after: 2027-02-15T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/26d4e7a76aa986684effaf3d9c86dc52da1d7f13/packages/smrt-app-mcp/AGENTS.md
    path: packages/smrt-app-mcp/AGENTS.md
    source_revision: 26d4e7a76aa986684effaf3d9c86dc52da1d7f13
    title: "packages/smrt-app-mcp/AGENTS.md (audit sink)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/26d4e7a76aa986684effaf3d9c86dc52da1d7f13/packages/smrt-app-mcp/src/audit-store.ts
    path: packages/smrt-app-mcp/src/audit-store.ts
    source_revision: 26d4e7a76aa986684effaf3d9c86dc52da1d7f13
    title: "packages/smrt-app-mcp/src/audit-store.ts (McpCallAudit, createSmrtMcpAuditStore)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/26d4e7a76aa986684effaf3d9c86dc52da1d7f13/packages/smrt-app-mcp/README.md
    path: packages/smrt-app-mcp/README.md
    source_revision: 26d4e7a76aa986684effaf3d9c86dc52da1d7f13
    title: "packages/smrt-app-mcp/README.md (persistent audit)"
---

# Audit agent tool calls

# Entry point

Pass `auditSink: createSmrtMcpAuditStore({ smrtOptions })` (from `@happyvertical/smrt-app-mcp/audit-store`) to the server, set `auditTenantId`, and read rows back with the store's `list({ tenantId, principalId?, tool? })`. `onToolCall` fires for every call for custom sinks. For change history of the data itself, see [audit-trail](/intents/audit-trail.md).[^s2]

# Why not hand-roll it

Records carry principal, tool, tenant, outcome (`allowed`, `denied`, `error`), error code, verified identity issuer, subject and client when the adapter stamped them, and argument key names only, never values, so the log does not become a second copy of sensitive data.[^s1][^s3] The `McpCallAudit` model is tenant-scoped and lives behind its own subpath so the main entry stays model-free.[^s2] A hand-written logger tends to record argument values and misses denied calls.

# Component pages

- [smrt-app-mcp](/components/smrt-app-mcp.md)
- [smrt-core](/components/smrt-core.md)

# Detection signals

- `regex:mcp_?(call|tool)_?log`
- `regex:tool_?call_?audit`
- `regex:console\.log\(.*tool`

[^s1]: `packages/smrt-app-mcp/AGENTS.md` at `26d4e7a76a`: packages/smrt-app-mcp/AGENTS.md (audit sink).
[^s2]: `packages/smrt-app-mcp/src/audit-store.ts` at `26d4e7a76a`: packages/smrt-app-mcp/src/audit-store.ts (McpCallAudit, createSmrtMcpAuditStore).
[^s3]: `packages/smrt-app-mcp/README.md` at `26d4e7a76a`: packages/smrt-app-mcp/README.md (persistent audit).
