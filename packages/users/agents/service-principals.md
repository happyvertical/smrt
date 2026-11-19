# Service principals (#5245)

A service principal is a User plus one Membership in exactly one tenant that an
automated actor (an agent, an integration) holds grants as. It can never sign
in, and hosts need no per-path refusals: smrt-users enforces that itself.

## Data shape

All new `User` columns are nullable and `readonly` (never mass-assigned over a
generated surface); every existing row is a person and is unaffected.

| Field | Person | Service principal |
|---|---|---|
| `principalKind` | `null` | `'service'` |
| `servicePrincipalTenantId` | `null` | the only tenant it is valid in |
| `servicePrincipalKey` | `null` | caller key, unique per tenant (`users_service_principal_tenant_key`) |
| `retiredAt` | `null` | set once on retirement, never cleared by the service |

`User.save()` refuses: an unknown `principalKind`; service fields on a person;
an email or username on a service principal (so no email- or username-keyed
path can address it); missing tenant/key; and `active`/`pending` status once
`retiredAt` is set. Its profile is a tenant-scoped `bot` profile, one per
principal (`profileId` is unique).

## Enforcement

- Mint: `SessionCollection.createSession` refuses any user whose stored
  `principal_kind` is non-null (fail closed for unknown kinds). Every mint in
  the package (sign-in methods, PIN layers, terminal approval, tenant-switch
  rotation, `SessionService.createSession`) goes through it; a structural test
  in `service-principal.test.ts` keeps it that way.
- Resolve: `SessionCollection.findValidSession` returns null for such a row,
  which covers `loadSessionContext` and every direct consumer (password,
  passkey, magic-link and OIDC step-up, invitation accept, mailbox auth).
  `loadSessionContext` also refuses a service principal session user or
  layered parent (`User.canHoldSession()`). OAuth grants and mobile bearers
  resolve through `loadSessionContext`.
- `TenantInvitationService` refuses its membership on issue, accept, mailbox
  authentication and the OIDC owner seam.
- app-runtime's external-OIDC MCP principal mapping refuses it.

## API

`ServicePrincipalService.create({ db, transaction: 'caller' })` is a trusted
host seam like invitation `prepare()`: the host authorizes tenant and role and
owns the transaction; the service never opens one.

- `createServicePrincipal({ tenantId, key, roleSlug | roleId, displayName? })`
  creates or replays by `(tenantId, key)`; a replay with another role, or of a
  retired key, is a `ServicePrincipalError` (409).
- `retireServicePrincipal({ tenantId, userId })` is permanent and idempotent:
  user suspended and stamped `retiredAt`, membership inactive, any session row
  revoked. Null for a person or another tenant's principal. There is no
  reactivation API; create a new principal under a new key.
- `isActiveServicePrincipal({ tenantId, userId })` is the per-call validity
  check: service principal, bound to exactly that tenant, not retired, user and
  home membership active. A membership added elsewhere never makes it valid
  there.
- `getServicePrincipal`, `findServicePrincipal({ tenantId, key })`,
  `listServicePrincipals({ tenantId, includeRetired? })` read records.

Concurrent creation is serialized per tenant on PostgreSQL (`FOR UPDATE` on
the tenant row) and arbitrated by the unique index everywhere.
