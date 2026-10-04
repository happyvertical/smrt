# @happyvertical/smrt-users

Multi-tenant user management with RBAC, hierarchical tenants, session handling, and SvelteKit integration.

## Installation

```bash
pnpm add @happyvertical/smrt-users
```

## Usage

### Application discovery conformance

The SvelteKit `createResourceListHandler()` export produces the app CLI
discovery response and now includes a deterministic `artifact`. Consumers can
import the published `@happyvertical/smrt-users/app-contract` entrypoint to
validate the schema/version selector and SHA-256 integrity digest before using
the embedded resource catalog. See
[`@happyvertical/smrt-app-cli`](../app-cli/README.md#discovery-conformance-artifact)
for the exact packaged-runtime pinning workflow.

### Roles and permissions

```typescript
import {
  RoleCollection, MembershipCollection, PermissionResolver,
} from '@happyvertical/smrt-users';

const db = { db: { type: 'sqlite', url: 'app.db' } };

// Seed system roles (owner, admin, member, viewer) — required at app init
const roles = await RoleCollection.create(db);
await roles.seedSystemRoles();

// Assign a user to a tenant with the admin role
const memberships = await MembershipCollection.create(db);
const adminRole = await roles.findBySlug('admin');
await (await memberships.create({
  userId: user.id, tenantId: tenant.id, roleId: adminRole.id,
})).save();

// Check permissions
const resolver = await PermissionResolver.create(db);
await resolver.hasPermission(user.id, tenant.id, 'articles.create');
```

### Manifest-derived permission catalog

s-m-r-t objects now contribute permissions automatically based on their public
surface area.

```typescript
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: { include: ['list', 'create', 'publish'] },
  cli: { include: ['get', 'archive'] },
  collection: 'articles',
  mcp: { include: ['update'] },
  tenantScoped: { mode: 'required' },
})
class Article extends SmrtObject {
  tenantId: string = '';
  title: string = '';

  async publish(): Promise<boolean> {
    return true;
  }

  async archive(): Promise<boolean> {
    return true;
  }
}
```

This produces the following permission slugs:

- `articles.read` from `list` or `get`
- `articles.create`
- `articles.update`
- `articles.publish`
- `articles.archive`

Non-public methods and actions that are not exposed through API, CLI, or MCP are
not added to the catalog.

### Sync the permission catalog

Use `syncPermissionCatalog()` during bootstrapping, migrations, or deploy hooks
to upsert discovered permissions into the `Permission` table.

```typescript
import { syncPermissionCatalog } from '@happyvertical/smrt-users';

const db = {
  db: {
    type: 'postgres' as const,
    url: process.env.DATABASE_URL!,
  },
};

const result = await syncPermissionCatalog(db);

console.log('created', result.created);
console.log('updated', result.updated);
console.log('unchanged', result.unchanged);
```

Catalog sync is additive and fail-closed:

- it creates missing `Permission` rows
- it updates `name`, `description`, and `category` by slug
- it does not auto-grant permissions to roles
- it does not delete stale permissions in v1
- it commits created/updated rows in small batched transactions; when calling
  it inside your own transaction, pass that transaction's database handle

### App-defined permissions in `smrt.config.ts`

Use package config for permissions that do not come from the manifest.

```typescript
// smrt.config.ts
import { defineConfig } from '@happyvertical/smrt-config';

export default defineConfig({
  packages: {
    users: {
      permissions: {
        custom: [
          {
            category: 'app',
            description: 'Allows access to the operations dashboard',
            name: 'View Operations Dashboard',
            slug: 'operations.dashboard',
          },
          {
            category: 'audits',
            name: 'Inspect Audit Rows',
            postgres: {
              bindings: [
                {
                  action: 'select',
                  tableName: 'audit_logs',
                },
                {
                  action: 'insert',
                  tableName: 'audit_logs',
                },
              ],
            },
            slug: 'audits.inspect',
          },
        ],
        postgres: {
          enabled: true,
        },
      },
    },
  },
});
```

Custom permissions merge with manifest-derived permissions by slug. If the same
slug is registered with conflicting metadata, s-m-r-t throws so the mismatch is
visible early.

### Runtime permission registration

Use `registerPermissionDefinitions()` when a package or integration needs to
declare permissions at runtime.

```typescript
import {
  registerPermissionDefinitions,
  syncPermissionCatalog,
} from '@happyvertical/smrt-users';

const unregister = registerPermissionDefinitions([
  {
    category: 'billing',
    description: 'Allows exporting invoices',
    name: 'Export Invoices',
    slug: 'invoices.export',
  },
]);

try {
  await syncPermissionCatalog({
    db: { type: 'sqlite', url: 'app.db' },
  });
} finally {
  unregister();
}
```

### Postgres RLS enforcement

For Postgres, s-m-r-t can generate and apply row-level security policies directly
from the permission catalog.

```typescript
import {
  applyPostgresPermissionPolicies,
  generatePostgresPermissionSql,
  syncPermissionCatalog,
} from '@happyvertical/smrt-users';

const db = {
  db: {
    type: 'postgres' as const,
    url: process.env.DATABASE_URL!,
  },
};

await syncPermissionCatalog(db);

const preview = generatePostgresPermissionSql(db);
console.log(preview.targets);
console.log(preview.skipped);

await applyPostgresPermissionPolicies(db);
```

Automatic policy generation currently applies only to objects that are:

- tenant-scoped with `tenantScoped: { mode: 'required' }`
- backed by a real Postgres table
- mapped to a single tenant field

Automatic CRUD policy mapping is fixed in v1:

- `SELECT` -> `<collection>.read`
- `INSERT` -> `<collection>.create`
- `UPDATE` -> `<collection>.update`
- `DELETE` -> `<collection>.delete`

Optional-tenancy and global tables are skipped and returned in
`result.skipped` instead of generating unsafe policies. Custom permissions can
participate in RLS by adding explicit Postgres bindings as shown above.

### Access requests (request access / waitlist)

Capture a prospective user from a public form *before* they are a real `User`,
let an operator triage, and **graduate** an approved request into a `User`
(optionally attached to a tenant). `createAccessRequest` is **public-safe** (no
auth) — expose it from your own rate-limited endpoint. Operator methods are gated
by an optional `authorize` hook (capabilities `access-requests:read` /
`access-requests:manage`). Lifecycle events let apps send invites/notifications;
this package never owns email delivery.

```typescript
import { AccessRequestService } from '@happyvertical/smrt-users';

const accessRequests = await AccessRequestService.create({
  db: { type: 'postgres', url: process.env.DATABASE_URL },

  // Optional: gate operator methods against your permission system.
  // (createAccessRequest is always public-safe and never calls this.)
  authorize: async ({ capability, by }) => {
    if (!by || !(await isPlatformOperator(by, capability))) {
      throw new Error(`Missing capability: ${capability}`);
    }
  },

  // Optional: react to lifecycle changes (send a magic link on graduate, etc.).
  onEvent: async (event) => {
    if (event.type === 'access-request.graduated' && event.user) {
      await sendWelcomeEmail(event.user.email);
    }
  },
});

// 1) Public form handler (app adds rate-limiting) — no auth required.
const request = await accessRequests.createAccessRequest({
  email: 'jane@example.com',
  name: 'Jane Doe',
  source: 'www',
  context: { company: 'Acme', intendedUse: 'evaluation' },
});

// 2) Operator triages the queue.
const open = await accessRequests.listAccessRequests({
  status: AccessRequestStatus.REQUESTED,
  by: operatorId,
});
await accessRequests.approveAccessRequest(request.id, { by: operatorId });

// 3) Graduate into a User — operator picks new-vs-existing tenant per request:
//    a) brand-new tenant, requester as owner
const { user, tenant, membership } = await accessRequests.graduateAccessRequest(
  request.id,
  { by: operatorId, tenant: { create: { name: 'Acme Inc' } } },
);
//    b) existing tenant:  { tenant: { tenantId, role: 'member' } }
//    c) user only:        { tenant: 'none' }
// Graduation is idempotent and reuses the existing User/Membership paths.
```

### SvelteKit hooks

```typescript
// hooks.server.ts
import { createSessionHandler } from '@happyvertical/smrt-users/sveltekit';

export const handle = createSessionHandler({
  db: { type: 'postgres', url: process.env.DATABASE_URL },
  enterTenantContext: true,
  postgresRls: true,
  ttl: 7 * 24 * 60 * 60, // 7 days in seconds
  skipPaths: ['/api/health'],
});
// Populates event.locals: { user, permissions, tenantId, sessionId }

// +page.server.ts
import { createSessionCookie, destroySessionCookie } from '@happyvertical/smrt-users/sveltekit';

await createSessionCookie(event, userId, tenantId, { db }); // login
await destroySessionCookie(event, { db });                   // logout
```

### OIDC login with Kanidm or Dex

Kanidm and Dex both work through the generic s-m-r-t OIDC flow. Configure one or
more providers under `packages.users.auth.oidc.providers`, then add login and
callback route handlers.

```typescript
// smrt.config.ts
import { defineConfig } from '@happyvertical/smrt-config';

export default defineConfig({
  packages: {
    users: {
      auth: {
        oidc: {
          defaultProvider: 'kanidm',
          providers: {
            kanidm: {
              kind: 'kanidm',
              issuer: process.env.KANIDM_ISSUER!,
              clientId: process.env.KANIDM_CLIENT_ID!,
              clientSecret: process.env.KANIDM_CLIENT_SECRET,
              redirectUri: 'http://localhost:5173/auth/kanidm/callback',
            },
            dex: {
              kind: 'dex',
              issuer: process.env.DEX_ISSUER!,
              clientId: process.env.DEX_CLIENT_ID!,
              clientSecret: process.env.DEX_CLIENT_SECRET,
              redirectUri: 'http://localhost:5173/auth/dex/callback',
            },
          },
        },
      },
    },
  },
});
```

```typescript
// src/routes/auth/[provider]/login/+server.ts
import { createOidcLoginHandler } from '@happyvertical/smrt-users/sveltekit';

export const GET = createOidcLoginHandler({
  db: { type: 'postgres', url: process.env.DATABASE_URL! },
});
```

```typescript
// src/routes/auth/[provider]/callback/+server.ts
import { createOidcCallbackHandler } from '@happyvertical/smrt-users/sveltekit';

export const GET = createOidcCallbackHandler({
  db: { type: 'postgres', url: process.env.DATABASE_URL! },
  successRedirect: '/dashboard',
});
```

The callback verifies `state`, PKCE, issuer, audience, nonce, and the provider
JWKS-signed ID token, falling back to the OIDC UserInfo endpoint when the ID
token omits required profile claims like `email`. Temporary transaction cookies
are HMAC-signed with the provider `clientSecret` when present; public clients
can pass `transactionCookieSecret` to the route helpers. On success it creates
or reuses a s-m-r-t `Profile`, links an `OidcIdentity`, creates or reuses a `User`,
records `lastLoginAt`, and sets the standard s-m-r-t session cookie.

RFC 9207 authorization-response issuer validation uses exact string comparison
against the discovered issuer before an authorization code or provider error is
trusted. When discovery advertises
`authorization_response_iss_parameter_supported: true`, a missing `iss` is also
rejected. Remote MCP deployments must require their external authorization
server to advertise and emit `iss`; see the
[remote MCP authorization guide](../../docs/content/architecture/remote-mcp-authorization.md).

The typed [OIDC provisioning decision matrix](../profiles/src/testing/oidcProvisioningDecisionMatrix.ts)
is the canonical behavior contract shared with Profiles. Its executable rows
declare exact reuse and new-identity outcomes, resolver invocation and
rebinding, ownership/collision failures, readiness, retries, adapter support,
public errors, and permitted Profile/OIDC identity/User/session creation. For a
new identity, the Users path is deliberately fail-closed before User or session
creation unless the selected Profile is the one safe, unowned global `Person`
allowed by that matrix. An owned Profile still returns `profile_owned` unless
the application explicitly supplies the owner authorization described below.
An exact issuer/subject link may instead continue to its already-owned canonical
global `Person`, but it cannot be rebound.

Canonical Profile failures use `CanonicalPersonProfileError` from
`@happyvertical/smrt-profiles`, with codes `ambiguous_email`, `email_mismatch`,
`email_key_backfill_required`, `missing_profile`, `non_person`,
`reservation_conflict`, or `tenant_scoped`.
User ownership/provisioning failures use `OidcProvisioningError`, with codes
`ambiguous_identity`, `concurrency_conflict`, `profile_owned`, `rejected`,
`transaction_required`, `user_email_backfill_required`, or
`user_email_conflict`. `completeOidcLogin()` rejects with the full error. The
ready-made callback handler passes that error to a configured `failureRedirect`
callback; without one it returns a generic 401 and does not expose account,
resolver, or database details to the browser.

Applications that already own an identity-reconciliation policy can provide a
`resolveProfile` hook without replacing transaction cookies, token exchange,
claim verification, or session creation:

```typescript
// src/routes/auth/[provider]/callback/+server.ts
import { createOidcCallbackHandler } from '@happyvertical/smrt-users/sveltekit';

export const GET = createOidcCallbackHandler({
  db: { type: 'postgres', url: process.env.DATABASE_URL! },
  resolveProfile: async ({ claims, db }) => {
    // All reads and writes must use this transaction-bound `db` handle.
    const profile = await resolveApplicationIdentity({ claims, db });

    // undefined: use SMRT's secure default
    // null: reject this login
    // Profile: select an application-reconciled canonical global Person
    return profile;
  },
  successRedirect: '/dashboard',
});
```

The service and SvelteKit handler run the hook after protocol claim validation
and inside the same provisioning transaction as OIDC identity and User
creation. Direct `UserCollection.getOrCreateFromOidc()` callers must first
validate and trust their supplied claims. The hook may run again after a
concurrent unique-key conflict, so it must be idempotent. For a new
issuer/subject, a supplied Profile is still validated as the unique, unowned
global `Person` for a verified email; resolver reuse is rejected unless
`email_verified` is exactly `true`. For an exact existing issuer/subject,
`null` still rejects login, a supplied Profile must be the already-linked
Profile and cannot rebind it, and stable-link owner/canonical-Person checks
still apply. The resolver receives a separate frozen claims snapshot; retry
locks, identity lookups, and persistence retain s-m-r-t's immutable internal
snapshot.

An invitation or approval workflow that pre-provisions both the canonical
global `Person` and its approved owning `User` can authorize the first identity
binding with `authorizeProfileOwner`:

```typescript
// src/routes/auth/[provider]/callback/+server.ts
import { ProfileCollection } from '@happyvertical/smrt-profiles';
import { createOidcCallbackHandler } from '@happyvertical/smrt-users/sveltekit';

export const GET = createOidcCallbackHandler({
  db: { type: 'postgres', url: process.env.DATABASE_URL! },
  authorizeProfileOwner: async ({ claims, db, users }) => {
    // This application record is the authorization decision. Select by its
    // approved IDs; do not authorize an account from matching email alone.
    const approval = await findApprovedOidcUser({
      db,
      email: claims.email,
    });
    if (!approval) return undefined; // preserve SMRT's secure default

    const profiles = await ProfileCollection.create({ db });
    const [profile, user] = await Promise.all([
      profiles.get({ id: approval.profileId }),
      users.get({ id: approval.userId }),
    ]);
    if (!profile || !user) return null; // explicitly reject stale approval
    return { profile, user };
  },
  successRedirect: '/dashboard',
});
```

The authorizer runs after protocol validation and inside the provisioning
transaction. It receives frozen normalized claims, the transaction-bound `db`,
and a `UserCollection` bound to that same transaction. Return both selected
objects only after application authorization; `undefined` uses the fail-closed
default and `null` rejects. s-m-r-t reloads and verifies the selected IDs rather
than trusting the returned objects: `email_verified` must be exactly `true`,
the Profile must be the unique canonical global `Person` for the claim email,
exactly one User must own it, and that User must have the same normalized email.
An exact issuer/subject cannot be rebound. Identity creation and login remain
atomic, and a race retry may invoke the authorizer again, so its reads and
writes must use only the supplied handles and be idempotent. Supplying both
`resolveProfile` and `authorizeProfileOwner` is allowed only when they select
the same Profile.

When userinfo supplies a missing email, its `email_verified` value travels with
that email as one source-bound pair. s-m-r-t never borrows a verification flag
from the ID token for a userinfo address, or from userinfo for an ID-token
address.

The concurrency guarantee uses four database arbiters: nullable unique
`OidcIdentity.identityKey`, private unique
`oidc_profile_email_reservations.email_key`, nullable unique `User.emailKey`,
and unique `User.profileId`. `User.emailKey` is derived from the trimmed,
lowercase email on every save, preventing independent database connections from
creating ambiguous User rows for the same address. Profile and User keys share
the exported TypeScript `normalizeIdentityEmail()` implementation; identity
lookups never depend on adapter-specific SQL `lower()` or `trim()` behavior.
Before trusting those keys, identity lookup verifies that every stored key
on a returned candidate still equals the application-normalized source email.
Every OIDC path validates or synchronizes its canonical Profile and therefore
requires the Profile email-key readiness marker. Creating a User or checking
User email uniqueness additionally requires the User email-key marker. A stable
issuer/subject that already has an owning User skips only the User email-key
lookup and marker. Full table validation stays in the explicit backfill, while
guarded runtime paths use only indexed candidate rows.
In-process callbacks also acquire the exact issuer/subject and normalized email
locks in deterministic order, including when the same subject presents changed
email claims on independent database handles. SQLite and DuckDB also acquire a
database-URL transaction lock because one adapter cannot safely overlap
unrelated root transactions; PostgreSQL deadlock and serialization failures use
a bounded transaction retry. Owner-authorized binding uses the same contract:
pass the DuckDB root handle and let s-m-r-t serialize the callback transaction.
New OIDC Profiles use non-semantic unique slugs,
so equal IdP display names cannot overwrite one another through s-m-r-t's
natural-key upsert.
Existing installations must run `smrt db:status`, `smrt db:migrate`, then
`smrt db:status` before deploying this users version; legacy identities reserve
an address only after the Profile passes canonical validation, and existing
issuer/subject reuse synchronizes that reservation with the Profile's current
stored email. Stop or upgrade old Profile and User writers before migration.
Before migration, find duplicate ownership links:

```sql
SELECT profile_id, COUNT(*) AS user_count
FROM users
WHERE profile_id IS NOT NULL
GROUP BY profile_id
HAVING COUNT(*) > 1;
```

Reconcile every result before applying the unique Profile constraint; legacy
empty-string Profile placeholders should be normalized to `NULL`. Multiple
`NULL` links remain valid. After the schema migration, populate both durable
keys from a single deploy process:

```typescript
import { backfillProfileEmailKeys } from '@happyvertical/smrt-profiles';
import {
  backfillLegacyUserProfiles,
  backfillUserEmailKeys,
} from '@happyvertical/smrt-users';

await backfillProfileEmailKeys(database);
await backfillUserEmailKeys(database);
await backfillLegacyUserProfiles(database);
```

The supported backfills are transactional and idempotent. The User backfill
fails without changing rows if legacy emails are still ambiguous; reconcile
the reported normalized keys and rerun it. The legacy Profile backfill creates
and links a canonical global Person for each User whose Profile link is still
null or blank. It preserves the User ID and data, creates no OIDC identity, and
never infers ownership from email: any same-email Profile, duplicate User email,
or conflicting reservation must be reconciled explicitly before retrying. Its
marker records a successful pass but does not hide Users imported later. All
OIDC paths require the Profile
marker; paths that create a User or arbitrate User email uniqueness also require
the User marker. Run all three before enabling OIDC provisioning. Pass the
root database to provisioning on adapters such as DuckDB that do not support
nested savepoints; root adapters must expose `beginTransaction`. A handle
exposing only `transaction()` is ambiguous and fails closed before resolver
writes rather than risking a nested transaction that could roll back
caller-owned work. A transaction-bound handle reads an existing
`_smrt_backfills` table but never attempts tracker DDL; pass the root database
when initialization or recovery is needed. OIDC `iss` and `sub` are preserved as exact opaque,
case-sensitive identifiers (trim is used only to reject blank claims), so
whitespace-distinct subjects never reuse one another.

With `postgresRls: true`, s-m-r-t opens a request-scoped Postgres transaction,
loads the session, resolves permissions, and sets session variables used by the
generated RLS helpers:

- `smrt.tenant_id`
- `smrt.user_id`
- `smrt.session_id`
- `smrt.permissions`
- `smrt.super_admin_bypass`
- `smrt.system_context`

With `enterTenantContext: true`, the same request also enters
`@happyvertical/smrt-tenancy` context so regular collection access is scoped to
the current tenant in application code.

### Login rate limiting and lockout

Every credential-based sign-in (terminal approval, device PIN, and any
password or passkey flow an app adds) draws from one shared budget,
`LoginAttemptLimiter` (#3273). The budget lives in `users_login_attempts`, so it
holds across every replica on Postgres; keys are hashed, so the table never
becomes an index of emails or IPs.

```ts
import {
  InvalidCredentialsError,
  LoginAttemptLimiter,
  LoginRateLimitError,
} from '@happyvertical/smrt-users';

const limiter = await LoginAttemptLimiter.create({
  db,
  maxAttempts: 5,          // per key, per window
  windowSeconds: 300,
  lockout: { baseSeconds: 60, factor: 2, maxSeconds: 3600 },
  keyPepper: process.env.LOGIN_KEY_PEPPER,
});

const lease = await limiter.reserve({
  kind: 'password',
  subject: submittedEmailKey, // what the client typed — NOT a resolved user
  source: clientIp,           // or a device/station id
});
if (!lease.allowed) throw new LoginRateLimitError(lease); // 429 + Retry-After

try {
  // Always do the same work for an unknown account as for a wrong password.
  const ok = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, password);
  if (!ok || !user) {
    await lease.fail();
    throw new InvalidCredentialsError();
  }
  await lease.succeed();
} catch (error) {
  if (!(error instanceof InvalidCredentialsError)) await lease.release();
  throw error;
}
```

Subject and source are independent budgets; either one exhausted refuses the
attempt, and a refusal on the source hands the subject reservation back so one
noisy address cannot burn every account. The failure that exhausts a window
locks the key for `base × factor^n` seconds, where `n` counts consecutive
exhausted budgets; a success or idle time resets the streak. Every decision is
reported to a `LoginAuditSink` — by default a durable `UsersLoginAuditEvent`
row (pruned after 90 days by the retention sweep), or pass `audit` to forward
into the host's own log, or `audit: false`. `TerminalAuthService` uses this
limiter for approvals; pass `loginLimiter` to share one instance.

### Per-person PIN on an enrolled device

A shared tablet enrolled through the terminal device-code grant holds a
device-account bearer session. `DeviceCredentialService` (#3276) lets a person
sign in **on that device only** with a short credential and mints a session
*layered on* the device session: it carries `authMethod: 'pin'` and
`parentSessionId`, is valid only while the device session is, never widens
tenant scope, and signs out independently.

```ts
import { createDeviceCredentialHandlers } from '@happyvertical/smrt-users/sveltekit';

export const deviceAuth = createDeviceCredentialHandlers({
  db,
  pin: { pepper: process.env.PIN_PEPPER },      // required in production
  personIdleSeconds: 15 * 60,                   // sliding; default 8 hours
  personMaxSeconds: 10 * 60 * 60,               // absolute; default none
  // Optional: the most anyone may do on this device. Default: no ceiling.
  deviceCeiling: async (device) => devices.permissionCeilingFor(device.user.id),
  // smrt-users does not own a Device object: say whether this device
  // account is still an enrolled, active device.
  assertEnrolledDevice: async (device) =>
    (await devices.findActiveByUserId(device.user.id)) !== null,
});
// POST /api/device/pin/sign-in  → deviceAuth.pinSignIn   (device bearer + { userId, pin })
// POST /api/device/sign-out     → deviceAuth.signOut     (person bearer)
// PUT  /api/device/pin          → deviceAuth.setPin      (self with currentPin, or admin)
// POST /api/device/pin/reset    → deviceAuth.resetPin    (admin; forces a new PIN)
// DELETE /api/device/pin        → deviceAuth.clearPin
```

The tablet swaps its `Authorization` bearer to the returned `sessionId` for
person-attributed work; `loadSessionContext()` resolves it with `parent` set,
so host gates can tell a person-on-device session from a browser session via
`authMethod`/`parent` (also on `event.locals.authMethod` and
`event.locals.sessionParent`). Any bearer that is not a first-class
device-enrolled session — a browser cookie, a mobile session, another person's
layered session — is refused with the same 401 as a wrong PIN. Lockout is per
person **and** per device through the login limiter. Administering PINs needs
`users.pin.manage` from a non-PIN session; a PIN session can only change its
own PIN with the current one. An admin reset revokes the person's live PIN
sessions and flags `mustReset`; signing in with the temporary PIN then yields a
restricted session that resolves to no permissions and can only call `setPin`,
which ends it — the person signs in again with the new PIN.

**Whose authority.** The device session authenticates the tablet; the person's
session authorizes the work. Its `permissions` are resolved on every load from
the *person's* own membership in the device tenant (role plus per-membership
overrides) — never the device account's — so a welder and a foreman on the
same tablet get different permission sets. Both identities are on the resolved
context: `user` is the person and `parent` (`event.locals.sessionParent`, and
`session.parent` on the request permission context) is the device session and
its account, so a consumer can record "this person, at this tablet".

**Device ceiling.** `deviceCeiling(device)` may return permission slugs that
cap every person on that device. A non-null result is snapshotted into the
person's session at sign-in (`data.permissionCeiling`) and intersected with
their resolved permissions on every load; it only removes slugs, and `[]`
leaves none. A ceilinged session never receives `superAdminBypass` or
`systemContext` from `withSessionPermissionContext`, and
`assertOperationPermission` / `checkOperationPermission` called inside that
session deny anything outside the ceiling. Returning `null` (or
omitting the hook) means no ceiling. Because it is a snapshot, **a ceiling
change applies at each person's next sign-in**; a throwing hook refuses the
sign-in.

**Switching people.** `signOut` ends only the person's session. With
`singleOccupant` (default `true`) a successful sign-in also ends every other
person's session on that device session, so signing in as the next person is
the hand-over; a failed sign-in leaves the current person signed in. Set
`singleOccupant: false` for devices several people stay signed in on.
`personIdleSeconds` is a sliding idle timeout stored on the session
(`data.idleSeconds`), so it slides by that value whichever `SessionService`
resolves the bearer and is independent of the device session's long life.
`personMaxSeconds` adds an absolute lifetime (`data.absoluteExpiresAt`) that
activity cannot extend. `permissionCeiling`, `idleSeconds`, and
`absoluteExpiresAt` are reserved `Session.data` keys (`SESSION_DATA_KEYS`):
server-set at mint, never to be written from client input.

**Operational contracts.** `parent.sessionId` is the device's bearer
credential: keep `SessionContext.parent` / `locals.sessionParent` server-side
and give clients `parent.userId` as the device identity
(`Session.parentSessionId` is a sensitive field and never appears in public
serialization). Resolve person bearers with `service.loadPersonSession(token)`:
it re-checks `assertEnrolledDevice` on every call and revokes the person
session of a device that fails it. A host that resolves them through its own
`SessionService` must instead revoke the device's bearer session when it
un-enrols the device. PIN administration (`users.pin.manage`) reaches only
people with an active membership in the administrator's session tenant; the
PIN itself is one per person across tenants.

Existing installations need `smrt db:migrate` for the additive
`sessions.auth_method` / `sessions.parent_session_id` columns and the
`users_login_attempts`, `users_login_audit_events`, and
`users_pin_credentials` tables.

Other credential kinds (a fob or badge reader, say) implement
`DeviceCredentialVerifier` and go through `service.signIn(verifier, input)`;
`PinVerifier` is the reference implementation.

### Request-scoped database access

Generated SvelteKit helpers and custom server code can read the current
request-scoped database, which is especially useful when Postgres RLS is enabled
and you want collection operations to use the active transaction.

```typescript
import {
  getRequestScopedDatabase,
  withSessionPermissionContext,
} from '@happyvertical/smrt-users';

const response = await withSessionPermissionContext(
  {
    db: { type: 'postgres', url: process.env.DATABASE_URL! },
    enterTenantContext: true,
    postgresRls: true,
    sessionId,
  },
  async (context) => {
    const database = getRequestScopedDatabase();

    console.log(context.permissions);
    console.log(database === context.database); // true

    return new Response('ok');
  },
);
```

## Key Concepts

### Permission cascade (4 levels)

PermissionResolver evaluates permissions in order, where each level can add or remove grants:

1. **Tenant hierarchy** -- walk ancestors, apply TenantPermissionOverride at each level
2. **Membership role** -- base permissions from the user's role in the tenant
3. **Group roles** -- permissions from all groups the user belongs to in that tenant
4. **Membership overrides** -- per-user GRANT/DENY (DENY always wins)

Tenant-level inherited permissions are part of the effective permission set
returned by `resolvePermissions()` and `SessionService.loadSessionContext()`.

### Resource-scoped grants

Use `checkResourceOperationPermission()` where an application must restrict an
otherwise tenant-authorized operation to one exact resource. Pass the resource
tenant/type/id and an application-owned `verifyResource` callback. The guard
first requires the catalogued tenant permission, then requires an active exact
`ResourceGrant`; a grant for project A never matches project B. A resource deny
overrides a resource grant, while tenant and membership denies remain the
upstream gate. The verifier must load authoritative ownership and fail closed.

`ResourceGrantService` is the only public grant surface: generated REST and MCP
operations are disabled. Its caller supplies a catalogued administrative operation
for the bootstrap grant, avoiding a circular "already delegated" requirement.
Delegation requires a live, delegable parent owned by the actor and covering the
same tenant/resource/permission; chains are bounded and ancestor revocation
immediately invalidates every child at the next guard check.

### Hierarchical tenants

Tenants support parent-child trees (max depth 10). Two flags control inheritance: `cascadePermissions` (parent pushes down) and `inheritPermissions` (child accepts). Both must be true for permissions to flow.

The materialized `hierarchyPath` / `hierarchyLevel` are **derived by the
framework**: `Tenant.save()` recomputes them from the real `parentTenantId`
chain on every save — through the collection helpers, a plain
`tenant.parentTenantId = x; await tenant.save()`, or an STI subclass — and
re-materializes every descendant when they change. A missing parent, a cycle,
or a move that would push any descendant past the depth limit throws
`TenantHierarchyError` before anything is written. Never set them by hand.
Because a parent link carries authority down the tree, a new or changed
`parentTenantId` must also be visible under the caller's own tenancy scope
(the save loads it through `TenantCollection`); run platform-level reparenting
in `withSystemContext()`.

Both hierarchy features — `inheritsToDescendants` and the ancestor-read policy
below — walk that path and fail closed without it. Rows written before the
framework maintained it (a correct `parent_tenant_id` but an empty path at level
0) must be backfilled once, after `db:migrate`:

```sh
smrt db:materialize-tenant-hierarchy --dry-run   # report what would change
smrt db:materialize-tenant-hierarchy             # apply (idempotent)
```

Or programmatically: `await materializeTenantHierarchy(db, { dryRun })`. It
writes only rows that differ (a second run is a no-op), runs in one
transaction, touches only the two derived columns, and refuses — writing
nothing — when any tenant's parent chain is broken, listing the offenders.

**Upgrading an existing fleet.** Two things change the moment the new package
is deployed, before any backfill:

1. **Run `--dry-run` first, as a health check.** A tenant whose *real*
   `parent_tenant_id` chain is broken — a missing parent, a cycle, or deeper
   than 10 (older releases accepted explicit `hierarchyLevel`/`hierarchyPath`
   create inputs without checking) — now makes permission resolution for that
   tenant and its whole subtree throw `TenantHierarchyError`
   (`code`: `PARENT_NOT_FOUND`, `CIRCULAR_REFERENCE`, `MAX_DEPTH_EXCEEDED`)
   instead of guessing. The dry run lists exactly these rows; repair their
   `parent_tenant_id` by hand (the backfill refuses to write while any exist),
   then apply.
2. **The tenant-override cascade follows the real parent chain.** Resolution
   no longer trusts a stored path it cannot verify, so a never-materialized
   child now receives its real ancestors' `TenantPermissionOverride` rows in
   both directions — DENYs *and* GRANTs (subject to `cascadePermissions` /
   `inheritPermissions`). That is the intended cascade and what the backfill
   produces anyway, but ancestor GRANT overrides that were previously inert on
   such rows become live: audit them before rolling out. `inheritsToDescendants`
   and the ancestor-read policy stay dormant on those rows until the backfill
   runs.

Permission resolution works under the `@happyvertical/smrt-tenancy`
interceptor regardless of which users classes you register as tenant-scoped:
the resolver's own cross-tenant reads (ancestor tenant overrides, ancestor and
descendant memberships) run in the framework's system context, keyed by the
user and tenant being resolved. It returns permissions, never rows; your
application's reads stay filtered.

### Read-only ancestor visibility (opt-in, off by default)

Membership authority travels DOWN the hierarchy: a direct membership in the
tenant being resolved, or — per role, via `inheritsToDescendants` — the nearest
active ancestor membership. Nothing a user holds on a DESCENDANT contributes
anything at an ancestor, so a principal whose only membership is on a child
tenant resolves to **no permissions** at the root. That is the safe default and
it stays the default.

Some hierarchies legitimately need the other direction for *reading*: a
network-level list that members of the network's child publications are meant
to see. Declare it explicitly:

```typescript
// smrt.config.ts
export default defineConfig({
  packages: {
    users: {
      permissions: {
        ancestorRead: {
          // Descendant SYSTEM role slugs allowed to contribute upward.
          // Exact match, and only `tenantId: null, isSystem: true` roles
          // (what `seedSystemRoles()` creates) can match.
          roles: ['member', 'editor'],
          // Collections whose `read` may travel up. `*` matches any run of
          // characters and may appear anywhere (`'site_*'`, `'*_pages'`);
          // `'*'` alone means every collection the declared role can read.
          collections: ['publications', 'tenants'],
          // Hierarchy hops from the membership up to the tenant being
          // resolved. Default 1 (immediate parent only).
          maxDepth: 2,
        },
      },
    },
  },
});
```

With that declared, `resolvePermissions(user, networkRootId)` for a
publication-only `member` returns `publications.read` and `tenants.read` — and
nothing else. The bounds are hard:

| Rule | Behavior |
|---|---|
| Default | Off. Undeclared, malformed, or empty-on-either-axis policies resolve exactly as before. |
| Action | `read` only (`list`/`get` normalize to `read`). `create`/`update`/`delete`/custom actions can never travel upward. |
| Escalation | Intersected with **both** the declared role's own catalog grants **and** the principal's effective permissions in the contributing tenant. The role bound means a descendant administrator cannot widen the contribution with a tenant GRANT, a group role, or a membership GRANT; the effective bound means a DENY that removed the permission at home removes it at the ancestor too. |
| Role identity | Only a governed SYSTEM role (`tenantId` null, `isSystem: true`) can match a declared slug. Slugs are not unique across a hierarchy, so a tenant-scoped custom role named `member` contributes nothing — a descendant's administrator cannot mint its way into the allow-list. |
| Direction | Strictly upward, to verified ancestors only. Siblings share no ancestor relationship and are unreachable. |
| Precedence | Applies only when NO membership authorized the tenant. A direct membership (even inactive) still pins resolution; an ancestor tenant-level DENY still subtracts. |
| Hierarchy | The materialized `hierarchyPath` is verified link-by-link against real `parentTenantId` rows; stale, over-deep, or inconsistent paths fail closed. |
| Bypass | Super-admin and system-context bypass are unchanged. |

**This grants the operation, not the rows.** An ancestor-read grant authorizes
`publications.read` *at the ancestor*. It is not visibility of any sibling
tenant's rows: row scoping remains with the `@happyvertical/smrt-tenancy`
interceptor and the generated Postgres RLS policies, which still bind reads to
the tenant the context is entered with. A member of publication A authorized at
the network root still cannot read publication B's rows.

Resolution happens inside `PermissionResolver.resolvePermissions()`, the single
point `SessionService.loadSessionContext()`,
`withPrincipalPermissionContext()`, `assertOperationPermission()`, the
generated REST/MCP surfaces, and the published `smrt.permissions` RLS variable
all flow through — so every consumer sees one answer. Resolution is uncached:
a membership, role, or policy change takes effect on the next resolution, and
there is no permission cache to invalidate.

**Known limitation.** The grant carries no membership, so
`PermissionResolutionResult.membershipId` and
`loadSessionContext().tenantAuthorization.membershipId` stay `null`. A surface
that requires a non-empty `membershipId` for a required-tenant session — such as
`@happyvertical/smrt-app-runtime`'s deployed runtime — therefore still refuses
an ancestor-read-only principal (it fails closed, with
`tenant_context_unauthorized`). Consume the grant through
`withPrincipalPermissionContext()` / `assertOperationPermission()`, which read
the resolved permission set. Carrying `ancestorReadFromTenantIds` into
`tenantAuthorization` is tracked in #2947.

Bind a policy to one resolver instead of the global config (tests, embedded
runtimes) with `PermissionResolver.create(options, { ancestorReadPolicy })`;
pass `null` to force it off regardless of configuration.

#### Adoption note

This is additive and off by default — no schema migration is required, and no
existing deployment changes behavior until `permissions.ancestorRead` is
declared. It does require materialized tenant paths: run
`smrt db:materialize-tenant-hierarchy` once if your tenants were created before
the framework maintained `hierarchyPath` (see
[Hierarchical tenants](#hierarchical-tenants)). When
adopting it, declare the **narrowest** role and collection lists that make the
ancestor-level list work, and keep `maxDepth` at the smallest value your
hierarchy needs. `roles` must name system-role slugs; a tenant-scoped role with
the same slug is ignored by design. Do not reach for it to grant an ancestor-level action: if a
principal needs to *act* at the root, give it a root membership or a role
grant, not a read policy.

### Tenant policies

TenantService supports three modes: `flexible` (no auto-create), `personal` (auto-create on first login, deletable), `required` (auto-create, must keep at least one).

## API

### Models

| Export | Description |
|--------|-------------|
| `User` | Auth identity. Email auto-lowercased. `profileId` is a unique cross-package Profile reference (one User per non-null Profile). |
| `Tenant` | Organizational boundary. STI. Hierarchical via `parentTenantId`/`hierarchyPath`. |
| `Role` | Permission template. `tenantId = null` for system roles. `isSystem` blocks deletion. |
| `Permission` | Named capability. Slug format: `resource.action`. |
| `Session` | Server-side session. Secure UUID. TTL in seconds. `authMethod` records the channel; `parentSessionId` makes it a layered session valid only while its parent is. Reserved `data` keys (`SESSION_DATA_KEYS`) carry a permission ceiling, sliding idle timeout, and absolute expiry. |
| `UsersLoginAttempt`, `UsersLoginAuditEvent` | Hashed-key login budget rows and durable sign-in audit events (#3273). Closed generated surface. |
| `UsersPinCredential` | Per-person scrypt PIN hash for enrolled-device sign-in (#3276). Closed generated surface. |
| `Group` | Team within a tenant. Gains permissions via GroupRole. |
| `Membership` | User + Tenant + Role junction. UNIQUE(userId, tenantId). |
| `MembershipOverride` | Per-user permission grant/deny on a membership. |
| `TenantPermissionOverride` | Tenant-level permission override (INHERIT/GRANT/DENY). |
| `GroupMember`, `GroupRole`, `RolePermission` | Junction tables for groups and role-permission assignments. |
| `AccessRequest` | "Request access / waitlist" record captured before a `User` exists. Closed generated surface — all access via `AccessRequestService`. |

### Collections

| Export | Description |
|--------|-------------|
| `UserCollection`, `TenantCollection`, `RoleCollection` | Core CRUD. TenantCollection adds `createChild()`, `getTree()`. RoleCollection adds `seedSystemRoles()`. |
| `PermissionCollection`, `SessionCollection` | Permission CRUD with `findByIds()`. Session CRUD with `findValidSession()`, `deleteExpired()`. |
| `MembershipCollection` | Membership CRUD, `findByUserAndTenant()` |
| `MembershipOverrideCollection`, `TenantPermissionOverrideCollection` | Override management at membership and tenant levels |
| `GroupCollection`, `GroupMemberCollection`, `GroupRoleCollection`, `RolePermissionCollection` | Group and role-permission junction management |
| `AccessRequestCollection` | AccessRequest queries: `findByEmail()`, `findOpenByEmail()`, `findByStatus()`, `findOpen()` |
| `UsersLoginAttemptCollection`, `UsersLoginAuditEventCollection`, `UsersPinCredentialCollection` | Atomic limiter primitives, audit storage, and PIN credential rows behind the services below |

### Services

| Export | Description |
|--------|-------------|
| `PermissionResolver` | Resolves effective permissions via 4-level cascade. `hasPermission()`, `resolvePermissions()`. Honors the opt-in `permissions.ancestorRead` policy. |
| `normalizeAncestorReadPolicy()`, `getConfiguredAncestorReadPolicy()`, `isAncestorReadableSlug()` | Validate and apply the declared read-only ancestor-visibility policy. |
| `PermissionCatalogService`, `syncPermissionCatalog()` | Discovers manifest/config/runtime permissions and upserts them into `Permission` rows. |
| `registerPermissionDefinitions()` | Register app or integration permissions at runtime and receive an unregister cleanup function. |
| `generatePostgresPermissionSql()`, `applyPostgresPermissionPolicies()` | Preview or apply Postgres RLS helper functions and table policies. |
| `SessionService` | High-level session management. `createSession()`, `loadSessionContext()`, `destroySession()`; tenant contexts include direct or inherited membership provenance, `authMethod`, and `parent` for layered sessions. |
| `LoginAttemptLimiter` | Shared sign-in budget with exponential lockout and audit (#3273): `reserve()` → lease `.fail()`/`.succeed()`/`.release()`. `LoginRateLimitError`, `InvalidCredentialsError`, `LoginAuditSink`, `DurableLoginAuditSink`. |
| `DeviceCredentialService` | Per-person sign-in layered on an enrolled device session (#3276): `signInWithPin()`, `signIn(verifier, input)`, `signOut()`, `setPin()`, `resetPin()`, `clearPin()`. Person authority with optional `deviceCeiling`, `singleOccupant` hand-over, `personIdleSeconds` / `personMaxSeconds`. `PinVerifier`, `DeviceCredentialVerifier`. |
| `OidcLoginService` | Generic OIDC authorization-code login with PKCE for Kanidm, Dex, and other standards-compliant providers. |
| `backfillLegacyUserProfiles` | Transactionally create and link canonical global Person Profiles for legacy Users; never creates OIDC identities or infers ownership. |
| `backfillUserEmailKeys` | Idempotently populate durable normalized-email keys after migrating legacy Users; fails closed on duplicates. |
| `materializeTenantHierarchy` | Idempotently backfill `hierarchy_path`/`hierarchy_level` from `parent_tenant_id` (`{ dryRun }`); refuses a broken chain without writing. CLI: `smrt db:materialize-tenant-hierarchy`. |
| `planTenantHierarchy` | Pure planner behind the backfill: expected fields, changes, and broken-chain problems for a set of tenant rows. |
| `OidcProfileResolver` | Transaction-bound pre-provision hook for application identity reconciliation. |
| `OidcProfileOwnerAuthorizer` | Transaction-bound application authorization for binding a first identity to an existing canonical Profile and its sole approved User owner. |
| `NormalizedOidcClaims` | Frozen resolver claims with required normalized `email`. |
| `withSessionPermissionContext()` | Loads a session, optionally enters tenancy context, and exposes a request-scoped database/permission context. |
| `getCurrentSessionPermissionContext()`, `getRequestScopedDatabase()` | Read the active request/session context inside app code. |
| `TenantService` | Policy-driven tenant lifecycle. `ensureTenantForUser()`, `createTenantWithOwnership()`. |
| `AccessRequestService` | Request-access/waitlist lifecycle + graduation. `createAccessRequest()` (public-safe), `list`/`get`/`approve`/`decline`/`cancel`, `graduateAccessRequest()` (new/existing/no tenant). Capability + event hooks. |

### SvelteKit (`@happyvertical/smrt-users/sveltekit`)

| Export | Description |
|--------|-------------|
| `createSessionHandler` | SvelteKit handle hook that populates `event.locals`, and can also enter tenancy context and Postgres RLS request transactions |
| `createSessionCookie` | Set session cookie after login |
| `destroySessionCookie` | Clear session cookie on logout |
| `switchSessionTenant` | Change tenant context for current session |
| `beginOidcLogin`, `completeOidcLogin` | Low-level SvelteKit helpers for custom OIDC login routes |
| `createOidcLoginHandler`, `createOidcCallbackHandler` | Ready-to-use SvelteKit route handlers for OIDC login and callback |
| `createMobileAuthHandlers` | Mountable `/api/mobile` PKCE, bearer session, bootstrap, logout, and route-guard handlers |
| `createDeviceCredentialHandlers` | Mountable PIN sign-in, sign-out, and PIN management handlers for enrolled devices |
| `resolveMobileUploadDedupKey` | Resolves `clientCaptureId` with `Idempotency-Key` fallback for app-owned multipart routes |
| `SessionLocals` | Type for `event.locals` (extend in `app.d.ts`) |

`createMobileAuthHandlers({ buildExtras })` places app-domain bootstrap data
under `MobileSessionBootstrap.extras`. Do not add app fields at the response
top level: they are outside the shared contract and the Kotlin client ignores
unknown top-level keys. Multipart ingestion remains app-owned; follow
[`mobile-upload-contract.md`](../../docs/content/architecture/mobile-upload-contract.md)
for authentication, deduplication, and status semantics.

### Types & Constants

| Export | Description |
|--------|-------------|
| `UserStatus`, `TenantStatus`, `SessionStatus`, `MembershipStatus` | Status enums |
| `AccessRequestStatus` | Access-request lifecycle enum (`REQUESTED`/`APPROVED`/`DECLINED`/`GRADUATED`/`CANCELED`) |
| `OverrideEffect`, `TenantPermissionEffect` | Override effect enums |
| `ACCESS_REQUEST_CAPABILITIES`, `AccessRequestError` | Operator capability slugs; typed domain error (`error.code`) |
| `DEFAULT_ROLE_SLUGS`, `DEFAULT_ROLES`, `DEFAULT_TENANT_POLICY` | System role slugs, role configs, default tenant policy |
| `DEFAULT_SESSION_TTL`, `MAX_TENANT_HIERARCHY_DEPTH` | 604800 (7 days in seconds), 10 |
| `DEFAULT_LOGIN_MAX_ATTEMPTS`, `DEFAULT_LOGIN_ATTEMPT_WINDOW_SECONDS`, `DEFAULT_LOGIN_LOCKOUT_*` | 5 attempts per 300 s window; lockout 60 s × 2ⁿ, capped at 3600 s |
| `DEFAULT_PIN_MANAGE_PERMISSION`, `PIN_LOGIN_KIND` | `users.pin.manage`, `pin` |
| `TenantHierarchyError` | Thrown on a missing parent, a cycle, or exceeding the hierarchy depth limit (`code`) |
| `TenantHierarchyMaterializationError` | Thrown by `materializeTenantHierarchy` when any tenant's parent chain is broken; lists `problems` |

## Dependencies

- `@happyvertical/smrt-core` -- ORM, `@smrt()` decorator, SmrtObject/SmrtCollection
- `@happyvertical/smrt-types` -- shared enums (UserStatus, SessionStatus, etc.)
- `@happyvertical/smrt-profiles` -- optional peer dependency for profile linking
- `jose` -- JWT/JWKS verification for OIDC and magic-link tokens
- `svelte` -- optional peer dependency for Svelte components

## License

MIT

### Upgrade duplicate role grants (#3329)

`RolePermission` now has a unique natural key `(role_id, permission_id)`.
Concurrent seeders converge through core's conflict-tolerant writes, preserving
one grant ID per pair. Permissions already use `(slug, context)` and system
roles use the tenant-aware natural key. System-role bootstrap holds a
PostgreSQL transaction advisory lock across its read/create sequence so two
seeders also return the same global (`tenant_id = NULL`) role IDs. The concurrent cold-seed test
checks all three catalogs. Seeding still uses bounded batches and is additive
unless `prune: true`; concurrent passes must use the same catalog/matrix.

Existing deployments need a maintenance window **before ordinary schema
migration**: adding the new unique index directly fails if duplicates exist.
Back up the database, stop every application writer and bootstrap/seed process,
and run the following once with the new package from an operator process:

```typescript
import { getDatabase } from '@happyvertical/sql';
import { deduplicateRolePermissions } from '@happyvertical/smrt-users';

const db = await getDatabase(databaseConfig);
console.log(await deduplicateRolePermissions(db, { dryRun: true }));
console.log(await deduplicateRolePermissions(db, {
  maintenanceConfirmed: true,
}));
```

The migration keeps the earliest `created_at` per pair (lowest `id` breaks ties;
null timestamps sort last), deletes only extra grants, and creates
`role_permissions_role_id_permission_id_idx` in the same transaction. Other
pairs and surviving grant data remain intact. Failure rolls the transaction
back; after resolving its cause, rerun the migration. Dry runs change nothing.
The helper requires transaction support and supports SQLite, DuckDB and
PostgreSQL; PostgreSQL locks the grant table while repairing it. Writer shutdown
is still required because older application versions cannot seed safely
against the new constraint. Apply the remaining application schema migrations,
run `smrt doctor --db` / `db:status --parity`, deploy the new version to every
writer, then resume traffic. Do not roll back application writers without also
restoring the pre-upgrade schema/database backup.
