# @happyvertical/smrt-app-mcp

Application-scoped MCP server wrapper for SMRT apps. The core owns generated
tool policy; `./sveltekit` owns the stateless Streamable HTTP transport.

## Purpose

- Wraps `@happyvertical/smrt-core` MCP generation with app-level tool allow-lists.
- Filters unauthenticated tool visibility to public read-only tools.
- Applies an optional principal-aware policy consistently to discovery and calls.
- Provides workflow assertions so app servers can reject unsafe or incomplete tool calls before dispatch.
- Exposes an opt-in durable Tasks extension through `@happyvertical/smrt-jobs`.

## Patterns

- Scopes, confirm and audit are server options (`toolScopes`, workflow
  `requiredScopes`/`requiresConfirm`, `confirmTools`, `auditSink`,
  `auditTenantId`). The scope check lives inside `passesToolPolicy` so tools and
  resources share it and an anonymous caller never passes a scoped tool; the
  confirm gate runs in `authorizeCall` before assertions and handlers and
  answers as an `isError` result (`confirm_required`, audited `denied`). Audit
  records hold argument KEY names only. `audit.ts` is model-free; the
  `@smrt()` `McpCallAudit` model lives only behind the `./audit-store` subpath
  (smrt#4957), never in the main entry.

- `approvals` (`src/approval-gate.ts`, structural `McpApprovalGate`) replaces
  `confirm: true` for gated tools: assertions first, then the gate opens or
  consumes an approval keyed by `mcpApprovalBindingHash` (tool, canonical args
  without `confirm`, tenant, principal). Fail closed (`approval_unavailable`);
  no decide path exists here; the adapter lives in `@happyvertical/smrt-approvals`
  (`createApprovalMcpGate`). Never import approvals from this package.

- Generate tools from core scoped to the allow-list (`MCPConfig.classNames`),
  then filter by allowed class names: a duplicate tool name among registered
  classes the app never publishes must not fail its catalog or calls (#3490).
  `mountMcpAppRoute`/`createDefaultMcpAppServer` resolve each model
  constructor to its registry-qualified name, so a same-named class elsewhere
  never collides; a raw simple name two classes share fails closed.
- Treat list/get tools as read-only; mutating tools require authentication unless the app deliberately wraps them with stronger policy.
- Keep app policy outside generated tool schemas. The wrapper owns auth, allow-list, and workflow assertion behavior.
- Return 404 for tools outside the app allow-list so private generated tools are not enumerated by mistake.
- Trust only a principal supplied by the application adapter. This package
  validates tokens and does not issue them; issuance lives in
  `@happyvertical/smrt-users` (see
  `docs/content/architecture/remote-mcp-authorization.md`). The opt-in `./auth` entry
  validates JWT access tokens and requires an application-owned principal mapper.
- Mount `mountMcpRoute` as one modern `POST` endpoint. It creates a fresh
  protocol server per request, emits no session id, and refuses subscriptions.
- `mountMcpAppRoute` (`src/defaults.ts` + `./sveltekit`) is the one-call app
  route: explicit `models` allow-list, required `requiredScopes`, principal from
  session locals (`principalFromSessionLocals`; absent `principalKind` denies
  unless `defaultPrincipalKind` is set). App policies compose with the
  default and may only narrow it. Its `Origin` check (default on; opt-in on
  `mountMcpRoute`) runs before auth and dispatch; no-`Origin` clients pass.
  `effects` filters the catalog by `mcpToolEffect` (excluded tools 404).
  `auth` swaps in bearer principals; `bindPrincipal` runs their dispatch in
  the app's principal context (RLS transaction), failing closed, and
  authorizes with the binder's narrowed (live) scopes; task lifecycle calls
  re-check the originating action against the allow-list and `effects`,
  after a principal-level `taskPrincipalPolicy` (defaults: scope policy);
  `mountMcpProtectedResourceMetadataRoute` serves only the advertised path.
- `runtime` (structural `McpAppRouteRuntime`; no app-runtime dependency)
  derives `smrtOptions`, `bindPrincipal` and `auth` on both mounts, the
  profile resolved per request after the origin check (adapters memoized per
  runtime × profile). Fail closed: missing bindings throw at mount; an
  unresolvable profile or missing hosted config rejects (500), never serves
  without the bearer adapter. Explicit options override; keep both forms
  byte-identical (`runtime-route.test.ts`). `./auth` loads lazily from
  `./sveltekit`.
- `createHostedMcpResourceAuth({ profile, runtime })`: locally, a runtime
  `verifyLocalMcpToken` yields the `sessionFallback` adapter
  (`createLocalMcpTokenAuth`): no `Authorization` header keeps the session
  principal; a presented bearer must verify (401, never cookie fallback); no
  metadata (404). Hosted, `runtime.resolveMcpPrincipal` is the default
  identity mapping; an explicit `resolvePrincipal` overrides it.
  `runtime.mcpSelfIssuer` (app is its own issuer, #5080): verify in process via
  `verifyAccessToken(token, resource)`, then `validateGrant(claims)` on every
  call (anything but `true` = 401); no JWKS/issuer env; metadata advertises
  its issuer. Override mappings never skip the liveness check.
- Adapters stamp `principal.tenantBinding` for `bindPrincipal`: the local
  token adapter always `direct`; the JWT adapter the mapping's value or
  `direct-or-inherited`. Never derive it from request input. Both adapters
  read principals/mappings from own data only (`own-data.ts`): inherited
  values, accessors and poison keys deny.
- A policy-denied call (scopes, `toolPolicy`, effects) answers exactly like an
  unknown tool (404 `Unknown MCP tool.`, no `data.code`) so the catalog cannot
  be probed; only the audit record carries `mcp_tool_access_denied` (the
  `McpAccessError.auditCode`). Anonymous callers still get 401 for a tool that
  needs authentication, which the OAuth challenge requires. Agent principals
  (`kind: 'agent'`, #5086) pass the default policy only when `principalKinds`
  lists them.
- Scope narrowing (#5110): consent may grant fewer scopes than the resource
  advertises, so `createMcpResourceAuth` needs only one advertised scope (none:
  403 `insufficient_scope`, `scope=` challenge; metadata unchanged). Per-tool
  needs come from `toolScopes`/workflow `requiredScopes`; an unmapped tool is
  open to any accepted token, and `requiredScopes` must stay `[]` for narrowed
  tokens. Tests: `narrowed-token.test.ts`.
- `mountMcpToolsRoute`/`mountMcpCallRoute` share the modern route's
  `auth`/`bindPrincipal` sequence (`authenticateAndDispatch`): a bearer agent
  lists and calls with the same live-capped scopes on every route. `mountMcpRoute`
  with `auth` but no `bindPrincipal` authorizes on token scopes only.
- Keep tool catalogs private by default. Public caching requires an explicit
  attestation and a global, unauthenticated, read-only, non-tenant catalog with
  no principal-aware policy.

- Host operations (`./host-operations`, browser-safe) are authored once and
  projected by `toMcpWorkflowTool`/`toWebMcpSpec`. `onToolCall` audits every
  call once; its principal/identity come from the adapter, and a failing hook
  never alters a result. Only `McpToolError`/`mapError` output reaches agents.
  Details: README "Host operations, audit and typed errors".

## Gotchas

- Public tool patterns are still constrained by read-only detection.
- Policy errors fail closed and expose only the shared safe denial envelope.
- Workflow assertions run before generated tool dispatch and should be deterministic.
- Tasks require a stable authenticated principal id, preserve its tenant boundary,
  and require the deployment to run a `TaskRunner` for the `mcp-tasks` queue.
- This package ships no stdio executable. Use `@happyvertical/smrt-app-cli` to
  bridge a deployed app endpoint to a local MCP client.
- `mountMcpToolsRoute` and `mountMcpCallRoute` are deprecated REST-shaped
  compatibility aliases, not MCP transports.
- This package is runtime app infrastructure, not the development MCP. Use `@happyvertical/smrt-dev-mcp` for agentic development knowledge, review, and architecture tooling.

HTTP transport loading: [agents/runtime-loading.md](agents/runtime-loading.md).
