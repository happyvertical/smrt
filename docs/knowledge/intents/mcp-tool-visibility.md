---
type: Capability
title: "Restrict which tools an agent sees"
description: "Reach for smrt-app-mcp allow-lists, toolScopes, toolPolicy and the confirm gate before filtering tools by hand."
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
    title: "packages/smrt-app-mcp/AGENTS.md (scopes, confirm, allow-list)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/26d4e7a76aa986684effaf3d9c86dc52da1d7f13/packages/smrt-app-mcp/README.md
    path: packages/smrt-app-mcp/README.md
    source_revision: 26d4e7a76aa986684effaf3d9c86dc52da1d7f13
    title: "packages/smrt-app-mcp/README.md (Tool scopes, confirm gate and persistent audit)"
---

# Restrict which tools an agent sees

# Entry point

Pass `allowedClassNames` to publish only chosen models, `toolScopes` (glob pattern to required scopes) so a principal sees only tools whose scopes it holds, `toolPolicy` for principal-aware rules, and `confirmTools` to refuse a gated tool unless `arguments.confirm === true`. For actions that need a person to sign off, use `@happyvertical/smrt-approvals`; see [human-approvals](/intents/human-approvals.md).[^s2]

# Why not hand-roll it

The scope check lives inside the shared tool policy, so `tools/list`, tool calls and resources agree: a tool whose scopes the principal lacks is hidden from discovery and denied on call, an anonymous caller never passes a scoped tool, and the confirm gate runs before assertions and handlers and answers as an `isError` result.[^s1] Hand-filtering the list while leaving the call path open is the common failure.

# Component pages

- [smrt-app-mcp](/components/smrt-app-mcp.md)
- [smrt-approvals](/components/smrt-approvals.md)
- [smrt-core](/components/smrt-core.md)

# Detection signals

- `regex:tools\.filter\(`
- `regex:tool_?allow`
- `regex:confirm_required`

[^s1]: `packages/smrt-app-mcp/AGENTS.md` at `26d4e7a76a`: packages/smrt-app-mcp/AGENTS.md (scopes, confirm, allow-list).
[^s2]: `packages/smrt-app-mcp/README.md` at `26d4e7a76a`: packages/smrt-app-mcp/README.md (Tool scopes, confirm gate and persistent audit).
