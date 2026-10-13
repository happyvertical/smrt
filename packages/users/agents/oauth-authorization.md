# Hosted OAuth authorization

`SmrtOAuthAuthorizationStorage` implements the protocol-neutral storage contract
from `@happyvertical/auth/server`. Apply normal SMRT migrations before starting
the server. The six `users_oauth_*` models are sensitive and have no generated
REST, MCP or CLI operations. Keep their tables on the private application
connection; public catalog roles must not read them.

`SmrtOAuthAuthorizationService.create({ db, scopePermissions })` supplies the
session boundary. `approve(server, parsedRequest, sessionId)` loads the existing
session again, checks its active user and tenant membership, verifies every
scope's configured permissions, and records consent. Existing magic-link,
password and OIDC sessions work without a separate identity mapping. Parent
session validity and session permission ceilings are enforced by SessionService.
Unknown scopes fail closed. An empty permission mapping explicitly permits a
scope for any valid session. OAuth does not grant super-admin bypass.

Pass `service.identity` to the SDK server. It revalidates the stored consent on
both code exchange and refresh. A permission loss denies the grant rather than
silently expanding or partially authorizing it. The consent-time permission
snapshot is an upper bound even if the host later changes its scope mapping.

After `server.verifyAccessToken(token, resource)`, always call
`service.validateAccessTokenClaims(payload)`. A non-null result is a server-only
SessionContext whose permissions and permissionCeiling are limited to the
verified token's mapped scopes. Do not serialize that context: it contains the
session credential. The JWT carries only a non-secret `smrt_grant_id`, subject,
client, tenant and scopes. JWT signature verification alone does not check live
session, user, tenant or consent revocation.

`listGrants(sessionId)` returns safe account-settings projections.
`revokeGrant(sessionId, grantId)` checks ownership and atomically revokes the
consent, outstanding codes, and all refresh descendants. Revoking or replaying a
managed refresh token also revokes its consent, so existing access tokens fail
the live grant check. Repeating revocation is safe. A foreign grant returns false.

The `/sveltekit` export `createOAuthHandlers({ server, authorization,
getSessionId })` provides Fetch-compatible `authorize`, `consent`, `grants` and
`protocol` handlers. The host renders consent, supplies its existing cookie
lookup, and preserves a validated local return path through magic-link login.
Consent POST requires an exact same-origin Origin header and `decision=approve`;
requested OAuth parameters remain on the authorization URL and are revalidated
by the SDK. Grant revocation POST has the same origin check and takes `grantId`.
All account/consent responses use private, no-store. No handler authenticates a
session from OAuth client identity or accepts a browser-submitted user/tenant.

## Transaction invariants

Code consume uses a conditional write. Refresh rotation and revocation lock a
stable family row before reading token state; locking the token being replaced
alone would allow a concurrent revocation to miss an inserted descendant.
Managed operations lock the consent row first, then the family. Replacement
insertion, old-token consume and replay revocation share one database executor.
A failed insert rolls back consume. Revalidated scopes and claims are persisted
atomically before the SDK exposes the replacement. Undefined claims clear prior
claims. Narrowing cannot expand scopes, revive or modify a consumed token.

Retry only transaction failures classified as SQLite contention or PostgreSQL
serialization/deadlock, after adapter rollback, at most six retries. Never retry
protocol callbacks or other external effects. The database adapter must clean up
failed statements and support independent connections; a process-local mutex is
not a replica-safety mechanism.

## Behavior-to-test contract (#3659)

Every row runs in `src/__tests__/oauth-authorization.test.ts` on Node >=26 with
SQLite and real PostgreSQL. Commands:

```sh
pnpm --filter @happyvertical/smrt-users exec vitest run src/__tests__/oauth-authorization.test.ts
DATABASE_URL=postgres://postgres@127.0.0.1:55597/smrt_oauth pnpm --filter @happyvertical/smrt-users exec vitest run src/__tests__/oauth-authorization.test.ts
pnpm --filter @happyvertical/smrt-users typecheck
```

| Invariant / trigger | Positive | Negative / failure | Actor / context | Executor / external edge | Level |
| --- | --- | --- | --- | --- | --- |
| Register and consume code | Metadata survives new adapter; one concurrent winner | Wrong client, redirect, resource; expiry and replay | Registered client / subject | Independent DB connections; SDK code contract | Integration |
| Rotate / replay refresh | One replacement | Reuse revokes every descendant | Same family across replicas | Stable family lock, same transaction | Integration |
| Rotation rollback / revoke race | Retry after insertion failure works | Duplicate replacement aborts consume; revoke cannot miss descendant | Same family, simultaneous operations | Real rollback and independent executors | Integration |
| Narrow replacement | Subset and replacement claims persist through subsequent rotation; undefined claims clear old claims | Expansion, hash mismatch, consumed/revoked token | Authenticated client / original family | SDK fail-closed narrowing contract, atomic locked update | Integration |
| Explicit recovery factory | Recreates configured connection after invalidation | Instance-only fails closed; ordinary storage failure propagates | Storage owner / configured database | Injected failure boundary plus real independent-connection races | Unit + integration |
| Access revocation | Another adapter sees it; repeats safe | Expired revocation no longer effective | Possessor of verified access token | Unique insert with conflict handling | Integration |
| Consent/grant ownership | Own grant can list/revoke | Other subject, tenant, scope deny; no session bearer in projection | Owner A/B × grant A/B | Live session + consent reads; atomic cascade | Integration |
| Live identity and ceiling | Current permission allows | Inactive user/membership, changed session ceiling, destroyed session | Active vs revoked context | SessionService and current RBAC | Integration |
| Code/live revoke cascade | Valid code exchanges | Membership loss before exchange; refresh revoke kills access | Original subject/tenant | SDK revalidateConsent callback | Integration |
| Consent snapshot / tenant | Original mapped scope | Later permission mapping expansion; inactive tenant | Owner × current tenant | Stored upper bound plus live permission checks | Integration |
| Layered session / expiry | Parent and child valid | Parent destroyed or child expired | Person session on device parent | Existing session controls | Integration |
| Consent route | Same-origin explicit approval | Missing/foreign Origin, denial, revoked session | Browser session / untrusted POST | Fetch request and SDK parsing | Route + DB |

This is new functionality, so a base-regression comparison is N/A: base has no
OAuth authorization storage or session grant API. Positive/negative contract
cases exercise real persistence rather than mocked SQL. Remote-provider outage
is N/A: the service has no external identity/provider call. SDK owns malformed
OAuth protocol, signature, PKCE and redirect parsing tests; hosts own their
consent UI, login return path and application-specific workspace policy.

### Recoverable local SQLite connections

Local libsql connections may be invalidated by the SQL adapter after a native
`SQLITE_BUSY` failure. An instance-only storage adapter fails closed in this
case; it does not silently reconnect and discard connection settings.
For recoverable local multi-replica operation, supply `recoverDatabase`:

```typescript
const storage = await SmrtOAuthAuthorizationStorage.create({
  db,
  recoverDatabase: async () => {
    const connection = await getDatabase({
      type: 'sqlite', url: configuredFileUrl, dbid: randomUUID(),
    });
    await connection.query('PRAGMA foreign_keys = ON');
    // Reapply any other application-required connection settings here.
    return connection;
  },
});
```

The factory is also used for the initial dedicated storage connection, keeping
storage recovery independent of a shared application/session connection. It
must return a migrated connection to the same database and restore every
required PRAGMA, attachment, temporary table or other per-connection setting.
It must not create application schema. Known invalidated failures may be retried
at most six times; ordinary storage failures propagate. PostgreSQL does not
need this factory. Connection ownership/disposal remains with the host factory.
