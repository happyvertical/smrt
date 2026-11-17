---
type: Capability
title: "Let agents or ChatGPT/Claude call my app over MCP"
description: "Reach for smrt-app-mcp before writing an MCP server, a REST-to-tool adapter or a ChatGPT connector by hand."
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
    resource: https://github.com/happyvertical/smrt/blob/8a6e6d05483ee701d6bc5eb3478a68b35373c5f3/packages/smrt-app-mcp/AGENTS.md
    path: packages/smrt-app-mcp/AGENTS.md
    source_revision: 8a6e6d05483ee701d6bc5eb3478a68b35373c5f3
    title: "packages/smrt-app-mcp/AGENTS.md (purpose and patterns)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/8a6e6d05483ee701d6bc5eb3478a68b35373c5f3/packages/smrt-app-mcp/src/sveltekit.ts
    path: packages/smrt-app-mcp/src/sveltekit.ts
    source_revision: 8a6e6d05483ee701d6bc5eb3478a68b35373c5f3
    title: "packages/smrt-app-mcp/src/sveltekit.ts (mountMcpAppRoute)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/8a6e6d05483ee701d6bc5eb3478a68b35373c5f3/docs/content/architecture/remote-mcp-authorization.md
    path: docs/content/architecture/remote-mcp-authorization.md
    source_revision: 8a6e6d05483ee701d6bc5eb3478a68b35373c5f3
    title: "docs/content/architecture/remote-mcp-authorization.md (remote deployment contract)"
---

# Let agents or ChatGPT/Claude call my app over MCP

# Entry point

Mount one stateless Streamable HTTP endpoint with `mountMcpAppRoute({ ... })` from `@happyvertical/smrt-app-mcp/sveltekit` (or `createMcpAppServer()` for another transport) passing the `models` to publish (`createMcpAppServer()` takes `allowedClassNames`). Tools are generated from your `@smrt()` objects. A local stdio bridge, `smrt-mcp-bridge`, pipes a deployed app to desktop MCP clients. Claude and ChatGPT connect to the same `/api/mcp` URL; embedded UI uses `@happyvertical/smrt-mcp-apps` (portable bridge), and ChatGPT-only navigation and settings extras live in the optional `@happyvertical/smrt-mcp-openai`. For the credentials those clients present, see [mcp-oauth](/intents/mcp-oauth.md).[^s2]

# Why not hand-roll it

The route creates a fresh protocol server per request, emits no session id and returns 404 for tools outside the allow-list so private generated tools are not enumerated; list and get tools are treated as read-only and mutating tools need an authenticated principal.[^s1] Authorization, tenant isolation and the allow-list are applied on every call, and the deployment contract covers local, self-hosted and cloud profiles.[^s3] A hand-written tool adapter has none of that policy and drifts from the model schema.

# Component pages

- [smrt-app-mcp](/components/smrt-app-mcp.md)
- [smrt-app-runtime](/components/smrt-app-runtime.md)
- [smrt-mcp-apps](/components/smrt-mcp-apps.md)
- [smrt-mcp-openai](/components/smrt-mcp-openai.md)
- [smrt-core](/components/smrt-core.md)

# Detection signals

- `import:@modelcontextprotocol/sdk`
- `regex:StreamableHTTPServerTransport`
- `regex:tools/list`
- `regex:/api/mcp`

[^s1]: `packages/smrt-app-mcp/AGENTS.md` at `8a6e6d0548`: packages/smrt-app-mcp/AGENTS.md (purpose and patterns).
[^s2]: `packages/smrt-app-mcp/src/sveltekit.ts` at `8a6e6d0548`: packages/smrt-app-mcp/src/sveltekit.ts (mountMcpAppRoute).
[^s3]: `docs/content/architecture/remote-mcp-authorization.md` at `8a6e6d0548`: docs/content/architecture/remote-mcp-authorization.md (remote deployment contract).
