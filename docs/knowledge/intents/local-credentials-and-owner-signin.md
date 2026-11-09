---
type: Capability
title: "Local credentials, device tokens and owner sign-in"
description: "Reach for smrt-app-runtime's local token store and owner claim, and smrt-users sessions, before writing a token file, a keychain wrapper or a first-run sign-in."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-4878
  at: 2026-11-09T00:00:00Z
stale_after: 2027-02-07T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/7843feb08e5aa02a988154b9e55e5bb9c1b8b3de/packages/app-runtime/src/local-mcp-tokens.ts
    path: packages/app-runtime/src/local-mcp-tokens.ts
    source_revision: 7843feb08e5aa02a988154b9e55e5bb9c1b8b3de
    title: "packages/app-runtime/src/local-mcp-tokens.ts (HMAC storage, DEFAULT_/MAX_LOCAL_MCP_TOKEN_TTL_SECONDS, issue, verify)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/7843feb08e5aa02a988154b9e55e5bb9c1b8b3de/packages/app-runtime/src/index.ts
    path: packages/app-runtime/src/index.ts
    source_revision: 7843feb08e5aa02a988154b9e55e5bb9c1b8b3de
    title: "packages/app-runtime/src/index.ts (openLocalMcpTokenStore, claimOwner, issueBootstrapInvitation)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/7843feb08e5aa02a988154b9e55e5bb9c1b8b3de/packages/cli/src/app/operations.ts
    path: packages/cli/src/app/operations.ts
    source_revision: 7843feb08e5aa02a988154b9e55e5bb9c1b8b3de
    title: "packages/cli/src/app/operations.ts (loopback /setup onboarding URL)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/7843feb08e5aa02a988154b9e55e5bb9c1b8b3de/packages/app-runtime/src/sveltekit/local-mcp-credentials.ts
    path: packages/app-runtime/src/sveltekit/local-mcp-credentials.ts
    source_revision: 7843feb08e5aa02a988154b9e55e5bb9c1b8b3de
    title: "packages/app-runtime/src/sveltekit/local-mcp-credentials.ts (createLocalMcpCredentialHandler)"
  - id: s5
    resource: https://github.com/happyvertical/smrt/blob/7843feb08e5aa02a988154b9e55e5bb9c1b8b3de/packages/users/src/services/SessionService.ts
    path: packages/users/src/services/SessionService.ts
    source_revision: 7843feb08e5aa02a988154b9e55e5bb9c1b8b3de
    title: "packages/users/src/services/SessionService.ts (SessionService.createSession, loadSessionContext)"
  - id: s6
    resource: https://github.com/happyvertical/smrt/blob/7843feb08e5aa02a988154b9e55e5bb9c1b8b3de/packages/app-runtime/AGENTS.md
    path: packages/app-runtime/AGENTS.md
    source_revision: 7843feb08e5aa02a988154b9e55e5bb9c1b8b3de
    title: "packages/app-runtime/AGENTS.md (local profile, owner bootstrap, local MCP tokens)"
---

# Local credentials, device tokens and owner sign-in

# Entry point

Local-profile credentials live in `@happyvertical/smrt-app-runtime`. An operator command opens the token store of an initialized application with `openLocalMcpTokenStore(options)` (the store behind `smrt app token create|list|revoke`), then calls `issue()`, `list()`, `revoke()` and `verify()`.[^s2][^s3] First sign-in is `claimOwner()` on the runtime returned by `initializeLocalApplicationRuntime()`: it consumes a bootstrap token and creates the owner's `Person`, `User`, `Tenant`, owner `Role`/`Membership` and a `Session` in one transaction.[^s2] `smrt app` hands the owner a loopback URL of the form `http://127.0.0.1:<port>/setup?token=...`.[^s3] The session itself is smrt-users: `SessionService.createSession(userId, tenantId)` and `loadSessionContext()`.[^s5]

# Why not hand-roll it

`local-mcp-tokens.ts` stores no bearer material: only a domain-separated HMAC of the token, keyed by the local application secret, goes into the runtime-owned `_smrt_local_mcp_tokens` table, and the token is returned once, by `issue()`. Tokens are bound to the owner's user and tenant, issue refuses scopes the owner lacks, and `verify()` returns `null` for a malformed, unknown, revoked or expired token or an owner who is no longer active.[^s1] Lifetime is validated between one minute and 365 days (default 30 days); there is no non-expiring token.[^s1] The owner claim is loopback-only and single-use: the bootstrap invitation defaults to a ten-minute lifetime (at most fifteen minutes), only its HMAC is stored, and the claim is a conditional `UPDATE` inside the transaction, so a wrong, replayed or expired token fails.[^s2][^s6] The opt-in `createLocalMcpCredentialHandler` accepts a desktop credential request only from a direct loopback peer with a matching Host and exact Origin and the sole active owner's session.[^s4][^s6] A token written to a JSON file under the home directory, or wrapped around a platform keychain, has none of that owner binding, scope check, revocation or `smrt app token` visibility. `SessionService.createSession()` takes a per-call or default TTL and `loadSessionContext()` rejects sessions whose user is inactive.[^s5]

Refresh is not implemented: `issue()` mints a token with a fixed lifetime that nothing renews and nothing revokes when its holder goes away. Automatic refresh for user and device credentials, and revoke-on-exit or idle timeout, are tracked in #4874; until it lands, call `issue()` and accept the store's default lifetime rather than adding a wrapper.

# Component pages

- [smrt-app-runtime](/components/smrt-app-runtime.md)
- [smrt-users](/components/smrt-users.md)

# Detection signals

- `import:keytar`
- `import:@napi-rs/keyring`
- `regex:security add-generic-password`
- `regex:homedir\(\).*(token\|credential)s?[\w.-]*\.json`
- `regex:~/\.[\w./-]*(token\|credential)`
- `regex:expiresIn\s*:\s*['"]\d+\s*[smhd]['"]`

[^s1]: `packages/app-runtime/src/local-mcp-tokens.ts` at `7843feb08e`: HMAC storage, DEFAULT_/MAX_LOCAL_MCP_TOKEN_TTL_SECONDS, issue, verify.
[^s2]: `packages/app-runtime/src/index.ts` at `7843feb08e`: openLocalMcpTokenStore, claimOwner, issueBootstrapInvitation.
[^s3]: `packages/cli/src/app/operations.ts` at `7843feb08e`: loopback /setup onboarding URL.
[^s4]: `packages/app-runtime/src/sveltekit/local-mcp-credentials.ts` at `7843feb08e`: createLocalMcpCredentialHandler.
[^s5]: `packages/users/src/services/SessionService.ts` at `7843feb08e`: SessionService.createSession, loadSessionContext.
[^s6]: `packages/app-runtime/AGENTS.md` at `7843feb08e`: local profile, owner bootstrap, local MCP tokens.
