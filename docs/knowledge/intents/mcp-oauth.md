---
type: Capability
title: "OAuth for my MCP endpoint"
description: "Reach for the smrt-users OAuth authorization server, or an external issuer behind smrt-app-mcp auth, before writing token minting or a custom credential path."
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
    resource: https://github.com/happyvertical/smrt/blob/26d4e7a76aa986684effaf3d9c86dc52da1d7f13/packages/users/agents/oauth-authorization.md
    path: packages/users/agents/oauth-authorization.md
    source_revision: 26d4e7a76aa986684effaf3d9c86dc52da1d7f13
    title: "packages/users/agents/oauth-authorization.md (hosted OAuth authorization)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/26d4e7a76aa986684effaf3d9c86dc52da1d7f13/packages/smrt-app-mcp/README.md
    path: packages/smrt-app-mcp/README.md
    source_revision: 26d4e7a76aa986684effaf3d9c86dc52da1d7f13
    title: "packages/smrt-app-mcp/README.md (Remote JWT authorization)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/26d4e7a76aa986684effaf3d9c86dc52da1d7f13/docs/content/architecture/remote-mcp-authorization.md
    path: docs/content/architecture/remote-mcp-authorization.md
    source_revision: 26d4e7a76aa986684effaf3d9c86dc52da1d7f13
    title: "docs/content/architecture/remote-mcp-authorization.md (issuer paths and profiles)"
---

# OAuth for my MCP endpoint

# Entry point

Two supported paths. (1) The app is its own issuer: `SmrtOAuthAuthorizationService.create({ db, scopePermissions })` and `createOAuthHandlers` from `@happyvertical/smrt-users/sveltekit` serve authorization code with S256 PKCE, refresh, RFC 8414 discovery, JWKS, revocation, RFC 8707 resource binding, RFC 9207 `iss` and opt-in Dynamic Client Registration; the host owns login and consent, and login may be any smrt-users session method including an external OIDC provider.[^s1] (2) An external issuer: validate its JWTs with `createMcpResourceAuth` from `@happyvertical/smrt-app-mcp/auth`, or `createHostedMcpResourceAuth` with the app runtime, and map claims to a principal.[^s2][^s3] A local-profile install uses `smrt app token` instead; see [local-credentials-and-owner-signin](/intents/local-credentials-and-owner-signin.md).

# Why not hand-roll it

The users service re-checks the live session, user, tenant membership and consent on code exchange and refresh, snapshots consent as an upper bound, and revokes a whole refresh family on replay; `validateAccessTokenClaims` must follow `verifyAccessToken` because JWT signature checks alone miss revocation.[^s1] The resource-server side rechecks membership per request and states the JWT revocation limits.[^s2][^s3] A custom bearer-token path skips PKCE, resource binding, rotation and revocation.

# Component pages

- [smrt-users](/components/smrt-users.md)
- [smrt-app-mcp](/components/smrt-app-mcp.md)
- [smrt-app-runtime](/components/smrt-app-runtime.md)

# Detection signals

- `import:oidc-provider`
- `import:jsonwebtoken`
- `import:jose`
- `import:express-oauth2-jwt-bearer`
- `regex:code_challenge`
- `regex:authorization_code`

[^s1]: `packages/users/agents/oauth-authorization.md` at `26d4e7a76a`: packages/users/agents/oauth-authorization.md (hosted OAuth authorization).
[^s2]: `packages/smrt-app-mcp/README.md` at `26d4e7a76a`: packages/smrt-app-mcp/README.md (Remote JWT authorization).
[^s3]: `docs/content/architecture/remote-mcp-authorization.md` at `26d4e7a76a`: docs/content/architecture/remote-mcp-authorization.md (issuer paths and profiles).
