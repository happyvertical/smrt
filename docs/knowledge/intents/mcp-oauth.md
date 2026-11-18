---
type: Capability
title: "OAuth for my MCP endpoint"
description: "Reach for the smrt-users OAuth authorization server wired through the runtime mcp.authorizationServer option, or an external issuer behind smrt-app-mcp auth, before writing token minting or a custom credential path."
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
    resource: https://github.com/happyvertical/smrt/blob/e86fb5be45e40b032c89a398bb6d20dd2a1ce428/packages/users/agents/oauth-authorization.md
    path: packages/users/agents/oauth-authorization.md
    source_revision: e86fb5be45e40b032c89a398bb6d20dd2a1ce428
    title: "packages/users/agents/oauth-authorization.md (hosted OAuth authorization)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/398f57847405df54509d7ba3a5b8cf4c28d28edf/packages/smrt-app-mcp/README.md
    path: packages/smrt-app-mcp/README.md
    source_revision: 398f57847405df54509d7ba3a5b8cf4c28d28edf
    title: "packages/smrt-app-mcp/README.md (Remote JWT authorization)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/398f57847405df54509d7ba3a5b8cf4c28d28edf/docs/content/architecture/remote-mcp-authorization.md
    path: docs/content/architecture/remote-mcp-authorization.md
    source_revision: 398f57847405df54509d7ba3a5b8cf4c28d28edf
    title: "docs/content/architecture/remote-mcp-authorization.md (issuer paths and profiles)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/8c511d88ec6aae4e53b3df5d9d0911e6e727cd92/packages/app-runtime/agents/self-issuer-mcp.md
    path: packages/app-runtime/agents/self-issuer-mcp.md
    source_revision: 8c511d88ec6aae4e53b3df5d9d0911e6e727cd92
    title: "packages/app-runtime/agents/self-issuer-mcp.md (app as its own MCP issuer)"
---

# OAuth for my MCP endpoint

# Entry point

Two supported paths. (1) The app is its own issuer. Build the server with `createCimdAuthorizationServer` (`@happyvertical/smrt-users`, a plain SDK server unless you pass `clientIdMetadataDocuments`) over `SmrtOAuthAuthorizationStorage` and `SmrtOAuthAuthorizationService.create({ db, scopePermissions })`, mount `createOAuthHandlers({ server, authorization, getSessionId }).protocol` and the consent and grants handlers from `@happyvertical/smrt-users/sveltekit`, then pass `mcp: { authorizationServer: { server, authorization, resource, scopes } }` to `createSmrtSvelteKitRuntime`. The runtime verifies the app's own tokens in process, re-checks the grant, user and tenant on every call (revoke, then the next call is refused), maps `sub` and the live grant's tenant to the principal by default, and advertises its own issuer; the host owns login and consent and login may be an external OIDC provider.[^s1][^s4] Client registration is a choice, all opt-in: pre-register, Client ID Metadata Documents (`clientIdMetadataDocuments: { allowClientOrigin }`, required policy) for ChatGPT and Claude, or `dynamicClientRegistration: true` as a fallback.[^s1] (2) An external issuer: validate its JWTs with `createMcpResourceAuth` from `@happyvertical/smrt-app-mcp/auth`, or `createHostedMcpResourceAuth` with the app runtime, and map claims to a principal.[^s2][^s3] A local-profile install uses `smrt app token` instead; see [local-credentials-and-owner-signin](/intents/local-credentials-and-owner-signin.md). The ordered checklist is in the remote authorization contract.[^s3]

# Why not hand-roll it

The users service re-checks the live session, user, tenant membership and consent on code exchange and refresh, snapshots consent as an upper bound, and revokes a whole refresh family on replay; `validateAccessTokenClaims` must follow `verifyAccessToken` because JWT signature checks alone miss revocation, and the runtime option does that on every request so you cannot forget it.[^s1][^s4] The CIMD fetch is SSRF-guarded, deadline-bound and size-capped.[^s1] The resource-server side rechecks membership per request and states the JWT revocation limits.[^s2][^s3] A custom bearer-token path skips PKCE, resource binding, rotation and revocation.

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

[^s1]: `packages/users/agents/oauth-authorization.md` at `e86fb5be45`: packages/users/agents/oauth-authorization.md (hosted OAuth authorization).
[^s2]: `packages/smrt-app-mcp/README.md` at `398f578474`: packages/smrt-app-mcp/README.md (Remote JWT authorization).
[^s3]: `docs/content/architecture/remote-mcp-authorization.md` at `398f578474`: docs/content/architecture/remote-mcp-authorization.md (issuer paths and profiles).
[^s4]: `packages/app-runtime/agents/self-issuer-mcp.md` at `8c511d88ec`: packages/app-runtime/agents/self-issuer-mcp.md (app as its own MCP issuer).
