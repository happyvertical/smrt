# ADR 0002: Portable MCP Apps with optional OpenAI integration

Status: accepted architecture for implementation; runtime support remains staged.
Parent: [#3202](https://github.com/happyvertical/smrt/issues/3202), M0: [#3203](https://github.com/happyvertical/smrt/issues/3203).

## Context

SMRT has server MCP, browser WebMCP, mounted UI interaction registries, and
application authorization. An MCP Apps iframe is another client of these
contracts. Iolaus is the reference application, not a source of job-search
semantics to put into core.

The OpenAI helper package currently peers on the monolithic SDK v1. SMRT's
shipped and generated servers require the split SDK v2. Package API compatibility
and wire protocol compatibility are different questions.

## Decision

Keep SDK v2 and protocol 2026-07-28. Implement the published MCP Apps resource
and metadata contracts through native v2 APIs in the owning SMRT package.
Do not install the incompatible OpenAI server helper, cast its v1 server to a
v2 server, vendor it, downgrade, or translate through a second v1 server.
Reconsider the upstream helper only after it publishes a compatible contract
and passes the same conformance gates. OpenAI metadata is an optional extension
of the portable contract, not a second operation or authorization engine.

The M0 SDK probe demonstrates native discovery, tools, structured results,
resources and entrypoint metadata over HTTP. It does not implement application
resource policy, a browser bridge, generated templates or a live host connection.
The existing generated-server suite remains the release authority for generated
servers; the small synthetic probe is not a replacement server.

## Ownership

| Owner | Responsibility | Dependency boundary |
|---|---|---|
| `core` | Canonical operation schemas, effects and exposure metadata; generated server serialization | No OpenAI or Svelte import |
| `smrt-app-mcp` | Authorized operation composition, protocol tools/resources and HTTP adapter | SDK v2; no browser/Svelte import in server entrypoints |
| Proposed `mcp-apps` | Framework-neutral browser bridge lifecycle and host context | Browser-only entry; no server credentials or domain policy |
| `web` | Existing framework-neutral Form/DataSurface registries and declared intents | Reused through public APIs |
| `svelte` | Thin binding from mounted components to the portable bridge | Svelte stays in explicitly selected UI entrypoints |
| Proposed `mcp-openai` | OpenAI metadata validation and optional host capabilities, separate server/browser exports | Opt-in dependency; no transitive dependency from core or ordinary MCP |
| `app-cli` | Local transport and credentials, forwarding supported resources and extension contracts | Must replace the current tool-only bridge assumption |
| `cli`, `template-sveltekit` | Scaffolding, packaging, diagnostics and reproducible asset builds | Enable integrations explicitly |
| `jobs`, action owners | Existing durable progress, confirmation, idempotency and audit | No competing lifecycle store in integration packages |
| Iolaus | Opportunity/application semantics, owner access, final approval | Reference consumer of public SMRT APIs |

Package names above reserve ownership; M0 exports no new public API. A later
stage must review concrete signatures with executable contract tests before
consumers depend on them. Keep the REST client-data engine separate from the
MCP host bridge.

## Consequences

Portable tools remain useful in headless clients. Browser WebMCP keeps its
mounted-page scope. A shared operation may be reachable through REST and MCP,
while a table filter remains a mounted UI intent. An embedded host is not
assumed to implement `document.modelContext`.

A native implementation requires schema/version drift tests against pinned
upstream contracts. This is intentional protocol implementation, not an SDK
compatibility shim. Platform-specific features remain unavailable when their
capability is missing. SDK feasibility does not establish host availability.

The normative [integration standard](../content/architecture/mcp-apps-integration.md)
defines security boundaries, fallbacks, staged acceptance and evidence limits.
