# @happyvertical/smrt-mcp-conformance-fixture

Private CI fixture for the MCP 2026-07-28 compatibility rail. The test
generates a Tier-1 server from `MCPGenerator`, negotiates it directly over
stdio with the exact scoped SDK v2 client, then runs the pinned official MCP
server conformance suite against the generated server factory. It also covers
the opt-in durable MCP tasks extension end to end, including completion and
cancellation of its correlated job.

```bash
pnpm --filter @happyvertical/smrt-mcp-conformance-fixture test
```

This package is not published and is not a production transport adapter. The
upstream conformance CLI's transitive monolithic v1 SDK is a development-only
exception; all direct dependencies and generated/runtime imports use exact
scoped v2 packages.

## Synthetic Iolaus cross-profile workload (#3217)

`src/iolaus-conformance.test.ts` reuses the #2547 runtime-profile reference
fixture: local owner bootstrap and file-backed SQLite, or its generated manifest
migration with real PostgreSQL and a separate runtime-owned worker connection.
The self-hosted composition uses `initializeDeployedApplicationRuntime`, verifies
the same signed JWT through JWKS, probes the real SDK local filesystem provider,
and reads a synthetic mode-0600 secret file. Readiness fails on revoked membership
or unsafe secret permissions, and closed runtimes reject new workers. This
exercises provider bindings locally; public TLS deployment and separate OS worker
process orchestration remain operator acceptance. Two ordinary
users own isolated tenants. A loopback issuer signs synthetic JWTs; the public
resource-auth adapter verifies them and reloads membership on every request.
The scoped SDK v2 client uses a real HTTP socket, not a mocked fetch handler.

The workload browses synthetic opportunities, inspects candidate evidence and
fit, records a decision, prepares bounded durable work, inspects immutable
SHA-256-bound materials, and opens a separate human review action. It has no
employer transmission operation. The human action uses the existing agents
preview/apply adapter and durable SQL state. Host continuation replies are
ordinary input and cannot grant this domain approval. Review claims the public
framework revision and atomically matches owner, tenant, material digest and
that revision before writing. Real SQLite/PostgreSQL triggers exercise raced
authority changes and failed-write rollback; stale hydrated saves must fail.
Domain material revision and frozen content stay unchanged. The view is built once
with Vite, declared as a portable resource, read through MCP, and rendered in
Chromium in an opaque `sandbox="allow-scripts"` frame with a CSP-bound inline
bundle. Trusted parent origin is immutable build configuration, never referrer
or runtime input. Tests require no-referrer success, direct host DOM denial,
foreign-parent denial and a configured-origin human review link. Its synthetic host forwards tool calls
through the same authorized SDK client. Native entrypoint/display metadata and
navigation reuse the optional OpenAI adapter; ordinary headless output remains
complete.

```bash
# Package tests (SQLite workflow plus existing generated stdio/official suite)
pnpm --filter @happyvertical/smrt-mcp-conformance-fixture test
pnpm --filter @happyvertical/smrt-mcp-conformance-fixture typecheck

# Required M8 aggregate: real SQLite + PostgreSQL + Chromium resource execution
# Set CI_POSTGRES_BASE_URL to a disposable test service; the canonical wrapper
# creates and drops a separate database. Install Playwright Chromium beforehand.
pnpm --filter @happyvertical/smrt-mcp-conformance-fixture test:m8
```

`test:postgres` runs the same two database scenarios without browser startup;
`test:m8` requires both the database service and Chromium and fails if either is
unavailable. The ordinary root test does not require an installed browser.
See [TEST-DESIGN.md](TEST-DESIGN.md) for the actor, transaction and failure matrix.

The exact direct MCP SDK version is **2.0.0**, server protocol **2026-07-28**,
and portable Apps protocol **2026-01-26**. Source revisions for portable/native
schemas are exported by their owning packages. This is synthetic-host evidence,
not an assertion about an actual OpenAI platform/version. Operational managed
cloud requires operator credentials and configured provider-owned adapters;
real OpenAI-host verification and downstream Iolaus adoption also remain epic
#3202 acceptance rows. Configuration projection or a fake provider does not
close them. No cloud provisioning, directory submission, or real application
content is used by this fixture.
