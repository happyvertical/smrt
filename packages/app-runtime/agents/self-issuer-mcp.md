# App as its own MCP issuer (#5080)

`mcp: { authorizationServer: { server, authorization, resource?, scopes? } }`
makes the app its own issuer: `runtime.mcpSelfIssuer` feeds
`createHostedMcpResourceAuth({ runtime })`, which verifies tokens in process
(`server.verifyAccessToken(token, resource)`) and calls `validateGrant` on every
request.

- `liveSelfGrant` re-derives user and tenant from the live grant row
  (`validateAccessTokenClaims`: grant not revoked, session/tenant live), then
  requires an active user and an active direct membership in that tenant. Any
  failure or throw denies. `sub`/`tenant_id` claims alone never select a tenant.
- It is also the default `resolveMcpPrincipal` mapping when `identity.issuer`
  is the app's own issuer; other issuers keep the OIDC path. An explicit
  `resolvePrincipal` overrides the mapping but never the liveness check.
- The local profile never uses it. Without the option nothing changes.
- Tests: `src/self-issuer-mcp.test.ts` (issue, call, revoke, refuse).

## Agent users as principals (#5086)

An agent is a `User` whose `Profile` is a `bot` profile (the framework's agent
marker, `resolveAgentProfile` in `@happyvertical/smrt-profiles`); there is no
separate kind column. `profileFactsOf` reads the live profile and its type slug
and yields `agent`, `human`, or `null`. `resolveMcpPrincipal` (both the
app-issued and the OIDC path) stamps that `kind`; a profile or type that cannot
be resolved denies (`null`), never defaults to a kind the policy accepts. The
session path publishes the same classification as `locals.principalKind`
(`null` = unauthenticated in `principalFromSessionLocals`), so a cookie session
cannot launder an agent into `human`.

- The default principal policy accepts `human` only; list `agent` in
  `principalKinds` to serve agents. Role permissions still bound them:
  `runAsPrincipal` caps token scopes by the agent's live role permissions on
  every request, so revoking a role permission removes the tool from the next
  `tools/list` and `tools/call`.
- The classification cannot be self-edited: `Profile.save`/`ProfileType.save`
  refuse an unprivileged request principal moving a profile to or from the
  `bot` type (or renaming that type), `AgentTypeChangeError`; system,
  super-admin and principal-free code (provisioning, CLI) is unchanged.
- Tests: `src/self-issuer-mcp.test.ts` (kind mapping; revoke/grant round trip
  through the real `runAsPrincipal`), `smrt-app-mcp` `agent-principals.test.ts`.

