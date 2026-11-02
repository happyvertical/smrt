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
