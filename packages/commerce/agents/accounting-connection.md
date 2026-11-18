# Tenant accounting connection (#5136)

A tenant connects one QuickBooks Online company. Source:
`src/accounting-connection.ts`, `src/models/AccountingConnection.ts`.

## Why smrt-commerce

Commerce already owns accounting sync (`syncFrozenInvoiceToAccounting`), depends
on `@happyvertical/accounting`, and takes smrt-secrets through a structural port
(`ConnectedPaymentSecretReader` precedent), so the connection, its mappings
(#5137) and the live-mode gate (#5138) share one tenant/realm/environment scope
without a new package or a dependency cycle. Commerce does not import
`@happyvertical/smrt-secrets`; the app passes a `SecretService`
(`AccountingSecretStore`: `storeForTenant`, `retrieveForTenant`,
`deleteForTenant`).

## Model

`AccountingConnection { tenantId, provider, realmId, environment, status,
lastError, lastErrorAt, connectedBy, connectedAt, disconnectedAt, tokenVersion,
lastRefreshedAt, leaseToken, leaseExpiresAt }`, unique on `(tenantId,
provider)`. Tenant-level: no user owns it. Status `connected`, `needs_reconnect`
or `disconnected`. The refresh token is only in smrt-secrets
(`accounting-quickbooks-refresh-token`, category `accounting.quickbooks`); the
row holds a version counter, never token material. `lastError` is a code
(`REAUTH_REQUIRED`), never provider text. Read-only generated surface; `save()`
refuses writes outside the commands; never deleted (it owns sync history).

## Commands

| Command | Does |
|---|---|
| `completeQuickBooksConnection(deps, { tenantId, realmId, environment, tokens, connectedBy })` | The completion hook for the shared OAuth connect flow (smrt#5128): the callback supplies `realmId`, environment and the exchanged tokens. Stores the refresh token, rebinds the tenant's row to `connected`, clears errors. Reconnecting reuses the row (the company may change). |
| `withTenantQuickBooksProvider(config, tenantId, fn)` | Ready provider for the tenant's connection; apps never handle tokens. |
| `disconnectQuickBooks(deps, { tenantId, oauth })` | Revoke at Intuit, delete the secret, mark `disconnected`; row and history stay. Idempotent. A failed revoke throws `REVOKE_FAILED` and changes nothing. |
| `getAccountingConnection(deps, tenantId)` | Read the row. |

Errors are `AccountingConnectionError` with `code` `INVALID_INPUT`,
`NOT_CONNECTED`, `NEEDS_RECONNECT`, `LEASE_TIMEOUT` or `REVOKE_FAILED`.

## Serialized rotation

Intuit rotates the refresh token on every refresh and a fresh `QuickBooksProvider`
has no access token, so it refreshes on first use: two concurrent users of the
stored token lose one. Locking only in `onTokenRefresh` would be too late (the
refresh already happened). Instead the whole first refresh runs under a
per-connection **lease** (`leaseToken`/`leaseExpiresAt`): a conditional
`UPDATE ... RETURNING` (SQLite and PostgreSQL), never a transaction held across
the Intuit call or the secret write. Waiters poll up to `waitMs`, then throw
`LEASE_TIMEOUT`. Inside the lease the stored token is read, the provider is
created with `onTokenRefresh` persisting the rotated token (before the lease is
released), and `ensureAccessToken()` is called; `fn` then runs on the fresh
provider outside the lease. `completeQuickBooksConnection` and
`disconnectQuickBooks` take the same lease, so an in-flight refresh cannot
overwrite a fresh connect or resurrect a deleted secret.

A rejected grant (sdk#1541 `AccountingReauthRequiredError`, detected
structurally as `code === 'REAUTH_REQUIRED'`, or raw `invalid_grant`) is
re-checked: if the stored token changed meanwhile it retries once, otherwise the
connection becomes `needs_reconnect` and callers get `NEEDS_RECONNECT` without
further provider calls, until `completeQuickBooksConnection` runs again.

## SDK seams

- `@happyvertical/accounting` sdk#1541: `AccountingReauthRequiredError`
  (`code: 'REAUTH_REQUIRED'`) and `QuickBooksOAuthClient.refresh`. smrt matches
  the error structurally and only needs `revoke` from the OAuth client.
- A provider that accepts a seeded access token and expiry would avoid the
  refresh-per-provider; today every new provider refreshes once, which the lease
  covers. A later refresh by a long-lived provider (after about 55 minutes)
  persists through `onTokenRefresh` but is not leased: build providers per job.

## Live mode

`enableLiveAccounting` / `disableLiveAccounting` set the per-company production
enablement the sync functions check; see [live-mode gate](accounting-live-gate.md).
