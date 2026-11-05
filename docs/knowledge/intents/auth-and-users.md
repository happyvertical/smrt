---
type: Capability
title: "Auth, users and sessions"
description: "Reach for smrt-users before writing password hashing, sessions, login throttling or role checks."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-4687
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/users/src/services/credential-hash.ts
    path: packages/users/src/services/credential-hash.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/users/src/services/credential-hash.ts (scrypt hash, timingSafeEqual, scryptHashNeedsUpgrade)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/users/src/services/LoginAttemptLimiter.ts
    path: packages/users/src/services/LoginAttemptLimiter.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/users/src/services/LoginAttemptLimiter.ts (LoginAttemptLimiter.reserve, DEFAULT_LOGIN_*)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/users/src/services/SessionService.ts
    path: packages/users/src/services/SessionService.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/users/src/services/SessionService.ts (SessionService.createSession)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/users/AGENTS.md
    path: packages/users/AGENTS.md
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/users/AGENTS.md (models and authority)"
---

# Auth, users and sessions

# Entry point

Import from `@happyvertical/smrt-users` (SvelteKit handlers from `@happyvertical/smrt-users/sveltekit`). Identity is `User` (global) plus `Membership` per `Tenant` with `Role` permissions resolved by `PermissionResolver`; sessions by `SessionService.createSession(userId, tenantId)`; email-and-password sign-in by `PasswordCredentialService`, with passkey, device PIN, OIDC and mobile services alongside. Request-scoped tenant context comes from smrt-tenancy adapters (`createSvelteKitHandle`, `createExpressMiddleware`).[^s3]

# Why not hand-roll it

`credential-hash.ts` stores a self-describing `scrypt$N$r$p$salt$hash` string, compares with `timingSafeEqual`, and exposes `scryptHashNeedsUpgrade()` so stronger parameters roll out at the next sign-in.[^s1] `LoginAttemptLimiter` draws attempts from two independent budgets, the submitted subject and the source, stores both as hashes, locks out with exponential backoff (defaults: 5 attempts per 5 minutes, 60 s base, doubling, capped at one hour), and its contract says the credential check always runs so a response never reveals whether an identifier maps to an account.[^s2] The package invariants also make users global with tenant access only through `Membership`, and derive tenant hierarchy paths on save rather than trusting callers.[^s4] A hand-rolled login with bcrypt or a JWT library has none of the throttling, non-enumeration or tenant model.

# Component pages

- [smrt-users](/components/smrt-users.md)
- [smrt-tenancy](/components/smrt-tenancy.md)

# Detection signals

- `import:bcrypt`
- `import:bcryptjs`
- `import:argon2`
- `import:jsonwebtoken`
- `import:passport`
- `import:express-session`
- `import:lucia`

[^s1]: `packages/users/src/services/credential-hash.ts` at `478ae36900`: scrypt hash, timingSafeEqual, scryptHashNeedsUpgrade.
[^s2]: `packages/users/src/services/LoginAttemptLimiter.ts` at `478ae36900`: LoginAttemptLimiter.reserve, DEFAULT_LOGIN_*.
[^s3]: `packages/users/src/services/SessionService.ts` at `478ae36900`: SessionService.createSession.
[^s4]: `packages/users/AGENTS.md` at `478ae36900`: models and authority.
