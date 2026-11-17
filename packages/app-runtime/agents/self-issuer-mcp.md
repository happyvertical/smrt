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
