# @happyvertical/smrt-users

Multi-tenant identity, RBAC, hierarchical tenants, sessions, and SvelteKit auth.

## Modules

Read only the module relevant to the change; protocol and provisioning details
are not prerequisites for unrelated user-package work.

| Module | Scope | Module doc |
|---|---|---|
| `src/services/PermissionResolver.ts` | permission precedence, inherited memberships, guards, RLS, role seeding | [agents/permissions.md](agents/permissions.md) |
| `src/services/OidcLoginService.ts`, collections and OIDC handlers | identity reconciliation, transaction boundaries, migration readiness | [agents/oidc-provisioning.md](agents/oidc-provisioning.md) |
| `src/services/MobileAuthService.ts` | mobile handshake, bearer sessions, bootstrap extension boundary | [agents/mobile-auth.md](agents/mobile-auth.md) |
| `src/services/TerminalAuthService.ts`, `src/services/LoginAttemptLimiter.ts`, `src/collections/LoginAttemptCollection.ts` | terminal approval concurrency, shared login budget and lockout (#3273), retry-safe database fixtures | [agents/terminal-auth-testing.md](agents/terminal-auth-testing.md) |
| `src/services/DeviceCredentialService.ts` | per-person PIN layered on a device session (#3276), verifier seam for other credential kinds | this file, "Security boundaries" |
| `src/services/PasswordCredentialService.ts`, `src/sveltekit/password-handlers.ts` | email + password sign-in and password lifecycle (#3274); shared scrypt in `credential-hash.ts` | this file, "Security boundaries"; README "Password sign-in" |
| `src/services/PasskeyCredentialService.ts`, `src/sveltekit/passkey-handlers.ts`, `src/svelte/passkey.ts` | passkey (WebAuthn) sign-in and passkey lifecycle (#3275); library does all verification | this file, "Security boundaries"; README "Passkey sign-in" |
| `src/retention.ts` | expired session/token/CLI-auth reaping and retention sweep wiring | [agents/retention.md](agents/retention.md) |

## Models and authority

- Users are global; tenant access comes through Membership (unique user/tenant).
  User email is normalized and globally unique through readonly nullable
  `emailKey`. `profileId` is a unique cross-package reference: at most one User
  owns each non-null Profile.
- Tenant uses STI and a materialized hierarchy, maximum depth 10.
  `hierarchyPath`/`hierarchyLevel` are derived from `parentTenantId` by
  `Tenant.save()` on every save (any caller-supplied value is recomputed) and
  descendants are re-materialized when they change; never hand-maintain them.
  Legacy rows are backfilled with `smrt db:materialize-tenant-hierarchy`
  (`materializeTenantHierarchy()`). Tests that need a corrupt path must write it
  with raw SQL (#3036).
- Role with `tenantId = null` is available to all tenants; `isSystem` prevents
  deletion. `inheritsToDescendants` is opt-in. Seed owner/admin/member/viewer
  through `RoleCollection.seedSystemRoles()` at application initialization.
- Group roles apply only in their own tenant. Use `getGroupIdsForTenant()`,
  never cross-tenant `getGroupIds()`, for authorization.
- Upward visibility is opt-in and read-only: `permissions.ancestorRead`
  ({ roles, collections, maxDepth? }) lets a DESCENDANT membership contribute
  declared `<collection>.read` at an ancestor, only when no membership resolved
  there, intersected with BOTH the role's own catalog grants and the
  principal's effective permissions in that descendant, and only for SYSTEM
  roles (a tenant-scoped role sharing a declared slug is ignored). Off by default, never
  write, never lateral, and never row visibility — sibling rows stay scoped by
  tenancy/RLS. Read the permissions module before changing it.
- Membership DENY always wins. Direct inactive membership blocks inherited
  authority; a direct active membership pins resolution instead of unioning it
  with ancestors. Read the permissions module before changing these rules.
- AccessRequest has no generated API/MCP/CLI operations; access it through
  `AccessRequestService`. Its JSON field is `requestContext`, not reserved
  slug-scoping `context`.

## Security boundaries

- Generated REST/MCP operations on identity/RBAC models are list/get only.
  Route authentication does not authorize authority mutations, and these models
  are not tenant-scoped. Use permission-gated services or explicitly checked
  consumer handlers. Generated CLI is list/get or closed (`cli: false` for
  credential/grant models) because agents shell out to it; a `cli` without
  `include` is full CRUD (#3742). Their catalog slugs stay full via
  `USERS_AUTHORITY_CATALOG_MODELS`. Preserve the registry assertions in
  `security-audit-1400.test.ts` and `issue-3742-cli-surface-lockdown.test.ts`.
- Resource guards take the resource tenant, not the session tenant. Omit a
  session membership when targeting a different tenant; mismatches fail closed.
  `loadSessionContext().tenantAuthorization` must be checked by required-tenant
  consumers: null membership can represent inherited authority.
- Sessions use secure UUIDs; TTL is seconds (default seven days). Access marks
  expired sessions EXPIRED. Magic-link tokens are single use.
- `Session.authMethod` is server-set at mint time and never read from the
  client; every mint site in this package sets it. A session with
  `parentSessionId` is valid only while its parent validates
  (`loadSessionContext` enforces this; there is no FK cascade by design), may
  not switch to a tenant other than the parent's, and is revoked with its
  parent by `destroySession`.
- Credential sign-ins reserve through `LoginAttemptLimiter` BEFORE credential
  work and key the subject on the submitted identifier, never a resolved user,
  so unknown and wrong take the same path. Reservations are fail-closed: keep
  them on failure, release on success or abort, never skip the reserve.
  Limiter writes are raw SQL and bypass the change feed; the audit sink is the
  observability seam, and it must never throw into the sign-in path.
  Subject and source budgets are sized independently (#3531); `source: false`
  ignores the source key, so a reservation then needs a subject (fail closed).
  The `source-locked` audit entry never carries a subject or caller metadata.
- `DeviceCredentialService` accepts a person credential only from a
  first-class session whose `authMethod` is a device-enrollment method
  (`terminal` by default) and that the host's `assertEnrolledDevice` confirms.
  A layered or PIN session can never administer PINs regardless of
  permissions. PIN hashes carry a per-row salt and the configured pepper;
  treat an unset pepper as a production misconfiguration.
- A person session carries the PERSON's authority (resolved from their own
  membership on every load), never the device account's. `Session.data` keys
  in `SESSION_DATA_KEYS` are server-set controls enforced by the model:
  `permissionCeiling` only ever intersects (malformed fails closed to none)
  and suppresses `superAdminBypass`/`systemContext`; `absoluteExpiresAt`
  bounds `extend()` and `isValid()`; `idleSeconds` overrides the resolving
  service's TTL policy. Never write them from client input. The ceiling is a
  sign-in snapshot; `singleOccupant` revokes other children only AFTER a
  successful mint. A `mustReset` sign-in mints with an empty ceiling and
  `setPin` ends that session; do not grant it authority another way.
- `UsersPasswordCredential` is one row per person, sensitive, with no
  generated surface; `PasswordCredentialService` and its handlers are its only
  session-authorized read/write paths. The separate Node `./operator` entrypoint
  provisions new PostgreSQL owners from trusted database custody, atomically;
  never mount it in a browser/REST/MCP handler. Exact retries verify existing
  credentials without writes; partial/conflicting identities fail closed.
  See README "Trusted deployment owner provisioning".
  Sign-in normalizes the email like `emailKey`, reserves
  before work, always runs one scrypt verify (dummy hash when absent), never
  creates a user, and maps every non-rate-limit refusal to one
  `PasswordCredentialError`. It re-checks the credential after the mint (a
  rehash that keeps row and version is confirmed by re-verifying); the
  parameter-upgrade write is a guarded UPDATE that must never replace a
  rotated password, and verification against a weaker stored hash is padded
  to the policy's scrypt cost. Self-service writes are guarded on the proven
  credential (first set insert-only); session sweeps run before and after
  each write. Self-service needs the current password except for a first
  set; `users.password.manage` follows the PIN's single-tenant target
  rule and never resets the actor's own. Layered sessions never manage
  passwords; a `mustChange` sign-in mints an empty ceiling.
  `replaceForgottenPassword` (#3905, opt-in `recovery`) is the only
  self-service write without the current password: it decides on the stored
  session row (owner, first-class, no ceiling, listed non-password/pin
  `authMethod`, fresh `outOfBandProofAt` stamp) and ends every session,
  its own included. Never set that stamp from client input.
- `UsersPasskeyCredential` (many per person) and `UsersPasskeyChallenge` (consumed
  challenge ledger) are sensitive with no generated surface;
  `PasskeyCredentialService` and its handlers are the only paths. Verification is
  `@simplewebauthn/server`, loaded on first use (its `reflect-metadata` polyfill is process-wide) and external in the build; never hand-roll COSE/CBOR. Sign-in reserves on
  the submitted credential id before any work, requires user verification, checks
  user handle and a strictly advancing counter (`reason: 'counter'`), mints, then
  re-checks with a guarded counter UPDATE; a ceremony is an HMAC-signed
  `ceremonyId` consumed into the unique ledger (replay = refuse; set
  `challengeSecret` for multi-process). Unique arbiters are
  `INSERT … ON CONFLICT DO NOTHING`, never a caught constraint error. Register and
  self-remove need a session authenticated within `freshSessionSeconds`, decided
  on the stored row (`Session.getAuthenticatedAt()`: server-set
  `data.authenticatedAt`, which tenant-switch rotation carries forward, else
  `created_at`; malformed fails closed; `setSessionData` refuses the key),
  first-class, no ceiling, and its STORED `authMethod` in `freshAuthMethods` (default password/passkey/oidc/magic-link; never `terminal`, whose approval mints a fresh session for any holder of a stale one, nor `pin`); self list/rename also refuse a ceiling; `users.passkey.manage` follows the PIN's
  single-tenant rule, and `removeAllPasskeys` is admin-only, never self. Sessions
  end before and after every removal; `SESSION_DATA_KEYS.passkeyCredentialId` is
  server-set (`setSessionData` refuses it). State-changing handlers require
  `application/json` (415). Challenge rows are reaped only 10 minutes past expiry
  (clock skew).
- A layered session whose tenant differs from its parent's never loads (null
  is allowed: narrower). Limiter rows carry `retain_until`; retention must
  not fall back to a process-wide horizon.
- `Session.parentSessionId` is the parent's bearer: sensitive, never a
  `list()` filter (raw-SQL id reads, which also keep revocation sweeps free of
  caller list bounds), never serialized to clients. `users.pin.manage` reaches
  only people whose every active membership is in the actor's tenant (the PIN
  is global per person). A sign-in re-checks the verified
  credential generation AFTER the mint (`stillValid`); keep that ordering.
  Operation guards deny outside a session's ceiling; `loadPersonSession`
  re-checks device enrollment.
- Tenant switching verifies active membership before writing and rotates the
  session ID for non-null targets, revoking the old session. Persist the returned
  `SwitchTenantResult.sessionId`; `switchSessionTenant()` updates the cookie and
  preserves its security settings. Failed switches mutate nothing; null clears
  do not rotate, and layered sessions never rotate (a replacement would escape
  the revocation sweeps they depend on). Layers do not nest. `SessionCollection.setSessionTenant()` is unguarded and must
  never receive an untrusted tenant ID.
- OIDC provisioning is atomic and fail-closed. Preserve exact issuer/subject
  identifiers, claim-source email verification, unique global Person ownership,
  and transaction-bound reconciliation. Read the OIDC module and canonical
  scenario matrix before changing any provisioning path.

## Entry points and validation

`src/sveltekit/` owns `createSessionHandler`, `createSessionCookie`,
`destroySessionCookie`, and `switchSessionTenant`. Use README integration examples
rather than copying application setup into these instructions.

From the repository root:

```bash
pnpm --filter @happyvertical/smrt-users test
pnpm --filter @happyvertical/smrt-users typecheck
pnpm --filter @happyvertical/smrt-users test:postgres
```

Start with the relevant test file via `test -- src/__tests__/<file>.test.ts`.
Run `test:postgres` for RLS, principal context, OIDC, or terminal-auth database
changes. `typecheck` includes Svelte accessibility checks; plain `tsc` is
insufficient. Follow root knowledge freshness checks before shipping.

## Pending invitations

`TenantInvitationService.create({ db: tx, transaction: 'caller' }).prepare({
tenantId, email, roleSlug })` is a trusted host integration seam. The caller
must authorize the destination tenant and system role, serialize its invitation
scope, and own the entire transaction. It prepares only pending User and
Membership records, with a canonical global Person and email reservation;
it never proves email ownership, activates access, sends email, or mints login
credentials. Existing canonical User/Profile links remain unchanged; unowned
same-email Profiles require explicit reconciliation. Pending retries reuse rows,
active memberships remain active with their existing role, and inactive or
conflicting memberships fail closed. Caller failures must roll back the whole
transaction; retry identity uniqueness conflicts only after rollback. Run the
profile/user email-key backfills before using this service.

`issue({ membershipId })` requires the host to authorize that exact destination
and returns a signed single-use `{ membershipId, token, expiresAt }`; secure
delivery is the host’s responsibility (no email is sent). Configure `secret` and
optional `tokenExpiry` (1–604800 seconds, default one day) at service creation.
`accept({ membershipId, token, sessionId, expectedUserId? })` consumes the tenant
grant only after validating an independently authenticated, active exact User's
stored first-class OIDC, magic-link, password or passkey session. Layered,
permission-ceiling, terminal and unknown sessions fail closed. It activates only
the Membership; reuse/switch that session through canonical session APIs.
Never mint global identity sessions from an operator-copyable invitation.

For a new pending User, wire `authorizeOidcOwner(context, { membershipId, token })`
only into the canonical protocol-verified OIDC `authorizeProfileOwner` callback.
It requires the exact caller transaction, strict `email_verified: true` and the
exact canonical invitee email, consumes the grant and activates pending User
and Membership atomically before returning `{ profile, user, tenantId, membershipId }`.
Arbitrary claims must never reach this trusted callback seam. The canonical
binder still verifies ownership and issuer/subject authority before commit.
The signed scope fixes user, profile, tenant, membership and role; expiration,
replay, changed bindings, inactive membership and suspended users fail closed.
Nonce consumption and activation roll back together. `TenantInvitationError`
is an expected 400/403 refusal;
`MagicLinkError` represents invalid, expired or replayed proof. Database failures
remain distinct. Treat tokens as secrets, prefer URL fragments and POST bodies,
and never log or persist a copy outside the canonical token ledger.


## Independent emailed mailbox authentication

`MailboxAuthenticationService.create({db:tx,transaction:'caller',secret,loginLimiter})`
requests and verifies returning-client login without creating identities/sessions.
`request({email,sourceKey,deliver})` returns only `{requested:true}` for known,
unknown, malformed, pending, inactive or unauthorized accounts. The trusted server
`deliver({email,token,expiresAt})` callback sends only to the eligible canonical
active User's email; never expose a proof in HTTP responses/operator UI/logs,
including development. Ten-minute one-use proofs bind immutable User/Profile ids.
`authenticate({token,expectedUserId?,sessionId?})` rechecks canonical identity and
active tenant membership before consuming proof; returns only verified
`{userId,profileId,tenantId}` for the host's canonical magic-link session mint.
Existing signed-in identity must match; supplied sessions cannot have a parent,
permission ceiling, terminal/PIN/unknown method, or inactive principal.

For pending invitation onboarding, `requestMailboxAuthentication({membershipId,
token:projectGrant,sourceKey,deliver})` inspects but never consumes the signed
project grant, then delivers a DIFFERENT mailbox proof to the fixed invitee.
Only `{expiresAt}` is returned. `authenticateMailbox({membershipId,
invitationToken:projectGrant,token:mailedProof,expectedUserId?,sessionId?})` claims
BOTH proof nonces and activates pending canonical User/exact Membership in the
same caller transaction. Mailbox proof issuer binds all invitation ids, role and
SHA256 of the exact grant. A copied operator-visible grant cannot authenticate
identity. Repeated email requests do not burn the grant; only the first completed
authentication can claim it. Existing active-session/OIDC paths remain supported.

All refusals/caller failures must roll back the whole caller transaction. Mail
transport must reject on failure. Delivery is an external effect before commit:
a successfully delivered but rolled-back proof is unusable; retry may send another
mail. No session/authentication is valid without committed proof claims. The host
must set a bounded transport timeout and never return transport payloads/secrets.
No generic outbox/provider is required; compose the existing SDK email transport.

Both mail request operations REQUIRE a root-executor canonical
`LoginAttemptLimiter` passed as `loginLimiter`; missing limiters fail before
nonce/budget writes or delivery. Completion-only operations may omit it. Supply
the limiter independently from the caller transaction so
caller rollbacks cannot release send budgets (SQLite single-connection fixtures
cannot prove that production-pool separation). `sourceKey` is a trusted server
client-address key, never request-controlled forwarded headers; limiter hashes
and peppers it, never stores raw addresses/email. Each request retains its budget
through window expiry via `retainOnSuccess`, regardless of account eligibility.
Handle `LoginRateLimitError` with the same generic request response plus retry
policy. Returning request has a 250ms response floor; delivery latency remains
transport-dependent, so do not claim constant timing. Malformed/expired/replayed
proofs raise `MagicLinkError`; invitation binding/status refusals also use
`TenantInvitationError`. Database/transport faults remain distinguishable server
failures. Never swallow an error and commit a partially consumed transaction.

`MagicLinkService.inspect()` validates signed live nonce without claiming it;
it is preparation, never authentication. `verify()` remains the atomic claim.
Optional generated signed `subject` binds immutable identity; legacy callers
without a subject retain their existing result shape.

Focused matrix: `mailbox-authentication.test.ts` runs in memory SQLite by default;
`TEST_DB_ADAPTER=postgres` plus an explicit isolated `DATABASE_URL` creates a unique
schema per scenario and also exercises concurrent invitation/login proof claims.
It is registered in `test:postgres`; no shared local service fallback is used.

## Family invitations and preserved Person identity

Trusted hosts may use `prepare({tenantId,email,roleId})` instead of `roleSlug`
to select an exact destination-owned role (or genuine global system role). Both
selectors together, foreign-tenant roles and missing roles fail closed. The
legacy `roleSlug` path remains system-only. `existingProfilePolicy:'owned-person'`
is an explicit service option allowing an existing ACTIVE canonical User's
already-owned tenant Person; exact normalized email, Person discriminator, unique
ownership and active source-family membership/tenant are required. It never
rebinds profiles or credentials. New pending identities stay canonical global;
OIDC owner authorization still requires canonical global Person. Returning
`MailboxAuthenticationService` retains its existing global-only contract.

`UserCollection.requireOwnedPersonForTenant(userId,tenantId)` is a bounded
read for the exact current tenant actor, with active destination membership; it
validates the same preserved owned Person. System/bypass/different actors fail.
Consumers must use their transaction executor and treat returned profile data as
private identity data, never a cross-family directory.

Each `issue` rotates a random generation in canonical membership context memory
(`smrt/tenant-invitation`, `generation`) and signs it into grant bindings, so a
resend invalidates every earlier grant and its mailbox proofs. `revoke` affects
only pending membership, rotates generation and marks it inactive. `prepare`
may reprepare only service-revoked inactive membership with the same role;
manual inactive memberships stay refused. Malformed generation fails closed.
Never edit/forget this framework-owned state. Legacy grants without generation
remain valid until a rotation, expiry or consumption. Host scope/relationship
writes must follow acceptance on the same caller executor: a failure rolls back
nonces, activation, generation and host writes. Mint the canonical magic-link
session only after committed mailbox identity proof; the grant alone cannot mint.

### Retained send budgets with embedded caller transactions

Before opening a caller transaction, use exported
`reserveMailboxAuthenticationRequest({limiter,scope,sourceKey})`. Scope is
`{purpose:'returning',email}` or `{purpose:'invitation',tenantId,email}`. Pass
its opaque `MailboxRequestReservation` as `reservation` to the corresponding
request method, with the same limiter instance configured on the service and
the same trusted source key. The capability is a frozen empty object branded
only in a private WeakMap: copying/serializing/forging/reusing it does not carry
authority. Claim is synchronous and consumes even mismatched attempts before
any await. It has no release/refund method; budget is settled with
`retainOnSuccess` before the host transaction, so transport/caller rollback
cannot refund it. Reserve outside all caller transactions; SDK versions without
root transaction introspection cannot prove that the host followed this rule.

SQLite/DuckDB requests without a pre-reservation fail before writes or delivery.
PostgreSQL retains its independently supplied root-limiter implicit request path
and its legacy subject keys; do not claim those counters are pooled with the new
capability keys. Each host should consistently use its selected request path.
Each capability expires at the earlier of thirty seconds or the earliest actual
reserved key window end; allowed `LoginAttemptLease.budgetExpiresAt` reports that
Unix-millisecond deadline. Request rechecks expiry after awaited identity work,
before proof generation and before delivery. Never retain capabilities for later
work or carry one across processes. Capability subject budgets use purpose-separated immutable
`['returning',normalizedEmail]` and `['invitation',tenantId,normalizedEmail]`
tuples, so malformed returning email cannot collide with invitation scope and preparing/reissuing membership
or grant generations does not reset the send budget. Source budget namespace is
shared across both purposes. Returning malformed/unknown email intentionally
consumes normal source budget and returns no proof: a host's unknown invitation
preflight may reserve `{purpose:'returning',email:''}`, discard the capability
and return its uniform failure response without a service/proof call.
