# @happyvertical/smrt-app-runtime

Reusable infrastructure composition for s-m-r-t applications. The package
implements the validated profiles from `@happyvertical/smrt-config` without
forking domain objects, generated surfaces, effects, approvals, or job calls.

## Private local applications

```ts
import {
  initializeLocalApplicationRuntime,
} from '@happyvertical/smrt-app-runtime';

const { runtime, bootstrap, diagnostics } =
  await initializeLocalApplicationRuntime({
    appId: 'my-app',
    sourceRoot: process.cwd(),
    prepareDatabase: runApplicationMigrations,
  });

// Show bootstrap.token only in the loopback onboarding URL. The plaintext is
// returned once and only its HMAC is persisted.
```

Application migrations run through the explicit `prepareDatabase` hook while
the runtime holds the root lease. A rejected migration is normalized into a
`LocalRuntimeError` with the stable `migration_failed` code and the fixed,
secret-free message exported as `MIGRATION_FAILED_MESSAGE`: "The application
migration step failed; run pnpm app:setup and inspect the private migration
logs." The migration driver's own text — a likely carrier of a connection
string, credential, path, or environment value — is never surfaced; it is kept
as a non-enumerable `cause` for private logs. Startup releases the database
handle and the initialization lease, so the same application root and data
directory remain retryable once the migration is fixed.

The path resolver selects the current user's OS application-data directory
(`~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows, or
`$XDG_DATA_HOME` / `~/.local/share` on Linux). Secure initialization currently
requires Node to expose nonzero `O_NOFOLLOW` and `O_DIRECTORY` filesystem
flags; it fails closed on platforms without that custody support and therefore
does not yet claim Windows runtime support. The data root contains a mode-0600
SQLite database, a user-owned asset directory, and generated mode-0600
application secret material. The root must be a dedicated application
directory: placing it inside the source checkout or choosing an ancestor is
refused, as is choosing the user home itself or the filesystem root. An
explicitly configured root that already exists must already be
owned by the current user with mode `0700`; initialization rejects it without
changing permissions or creating artifacts when that custody proof fails.
An empty root is claimed with an app-specific, empty mode-0600 marker. A
populated root is accepted only with that valid marker, so selecting an
unrelated private directory fails without changing its contents. A pending
marker makes the claim crash-recoverable while the database is first acquired;
it is promoted atomically after the released SQL custody boundary verifies the
complete ancestor/root chain, including macOS ACLs. Failed custody removes the
pending claim and every directory only when they were created by that attempt;
an inherited pending claim and its database remain authoritative for retry.
Initializers for the same data root are serialized across processes by an
exclusive transaction in a dedicated SQLite lock database under a private,
root-keyed custody directory kept beside the data it protects:
`<parent of the data root>/.smrt-lease-<key>/initialization.sqlite`. That
parent has already passed the custody preflight and is the one location every
process sharing the data directory sees, so the lease also works inside a user
namespace (agent sandboxes, rootless containers) where `/tmp` reads as owned by
the overflow uid. The historical per-user `/tmp/.smrt-<uid>/<key>` lease is
still taken afterwards, so a process running an older release (which takes
only that lease) stays excluded. When `/tmp` fails the ancestry owner check
because its owner is unmapped, the legacy lease is taken lock-only: the lock
file is never written, every ancestor must still be a real directory that is
not group/world writable unless sticky, and the lock directories and file must
be current-user-owned and private. A held legacy lease therefore makes the new
process wait (and fail closed after two minutes). Inside a user namespace that
remaps the uid (for example `unshare -Ur`, where host uid 1000 reads as 0), the
legacy lease is taken for both the in-namespace uid (`/tmp/.smrt-0`, what an
older release inside the namespace locks) and, in that order, the uid's mapping
in `/proc/self/uid_map` (`/tmp/.smrt-<host uid>`, what an older host process
locks); identical paths are taken once, so a host process takes the single
lease it always did. Every new process takes the beside-data lease first, which
is what keeps the fixed legacy order deadlock-free. When the in-namespace uid
differs from its mapping and its `/tmp/.smrt-<uid>` root already exists as a
real directory owned by someone else (under `unshare -Ur`, host root's
`/tmp/.smrt-0` reads as the overflow uid), that one candidate is skipped: no
process in the namespace can hold a lease beneath a root it does not own. A
symlink there, and any problem with the mapped candidate, still fails closed.
A map that
cannot be read, parsed, or does not cover the current uid fails closed. Only
one namespace level is visible, so a doubly nested remap is not translated
past its parent. The residual rule: when the
legacy lock directory cannot be created at all (`/tmp` not writable or
read-only in that view) and no legacy lock file exists, the legacy lease is
skipped. When the data root's parent is not writable by the current user (or is
read-only) the secure `/tmp` lease is required instead, as before. The
released `@happyvertical/sql`
trusted-parent boundary validates each lease directory, its ancestors, and the lock
leaf for ownership, write permissions, static links, and macOS ACLs before it
opens the lock database. Atomic SQLite locking elects one owner without deleting
or replacing a pathname, so there is no stale-file ABA window and no PID or
clock lease. Process or worker death releases the kernel lock automatically. A
read-only path, custody, and ownership-marker preflight rejects an obviously
invalid application root before creating its lock-registry entry; the complete
checks run again under the lease before application-root mutation. The lease
covers storage acquisition, secret publication, SQLite tuning,
application migrations, and bootstrap construction. Contenders wait up to two
minutes for that complete sequence, so normal migrations can finish without
overlap. Marker or temporary-secret cleanup therefore cannot race another
active initializer.
Every existing path component is opened without following symbolic links and
checked against its canonical path before descendants or secret bytes are
written. The runtime then acquires SQLite through `@happyvertical/sql`'s
explicit `node:sqlite` trusted-parent custody boundary, rooted at the mode-0700
application data directory. Unsupported runtimes or platforms and unsafe
ownership, permissions, ACLs, or path components fail closed. The local
`runtime.databaseConfig()` and default `runtime.classOptions()` retain that
same driver, custody, and root configuration when application collections open
another connection; an explicit per-class database override still wins.

The application secret is published by atomically linking a fully written,
synced mode-0600 temporary file into place. Concurrent installers validate and
reuse the one winning value; an incomplete or malformed existing secret is
rejected rather than overwritten, and stale interrupted temporary files are
removed after a complete value is durably available.

The custody boundary prevents static link traversal and mutation by other OS
principals while the application retains control of that directory. Hostile
code already running as the same user is outside this boundary; isolating
same-account processes requires an OS sandbox and a descriptor-relative SQLite
VFS.

Owner onboarding binds to `127.0.0.1` by default and accepts only loopback IP
literals (`127.0.0.0/8` or `::1`), avoiding hostname-resolution ambiguity.
The first valid claim creates a tenant-bound `Person`, `User`, default `Tenant`,
owner `Role` / `Membership`, and server-side `Session` atomically. The owner
Person belongs to the actual created or adopted tenant; its shared profile type
remains global. Startup and setup are idempotent; replayed, expired, or
concurrent claims fail closed.
`ownerTenant: { slug, name, adoptExisting }` (also accepted by the SvelteKit
runtime) selects the bootstrap tenant; the default is a new tenant with slug
`default`. The default tenant, owner User, owner Person, and owner Membership
have separate UUIDv8 identifiers derived with domain-separated HMAC-SHA256
from the installation's private `secrets/application.secret`. Independent
installs of the same app get distinct identities and share the global built-in
role IDs. Restarts reuse the same installation identities. Treat
`secrets/application.secret` as installation identity material. Preserve it
with the database in protected backups and during a restore or move of the
same installation. Deleting, replacing, or rotating the file changes the
derived identities and invalidates existing bootstrap and local MCP tokens.
A data root that is copied, restored or moved is governed by installation
custody; see [Moving, restoring and copying an installation](#moving-restoring-and-copying-an-installation).
A restored data root keeps its identities only when its seed does, and runtime
initialization no longer silently regenerates a seed that went missing.

The invitation and active owner membership authorize the owner. The same
seed derives a separate writer UUID. The local runtime binds it to the
database so local edits to tracked rows identify this installation, including
after a restart.

A tenant with the selected slug causes `owner_tenant_conflict`, unless
`adoptExisting: true` explicitly allows adopting an active root tenant with
zero memberships of any status. An adopted tenant keeps its id and name.
The claim rejects an unrelated row using the reserved tenant UUID and an
account using the owner UUID or the claimed email. The owner Person and
Membership also use strict inserts. A failed claim rolls back
and leaves the invitation claimable.
Authenticated session TTLs are configured in whole seconds with a minimum of
one second, and invalid values are rejected before filesystem mutation.

Background jobs and application-defined paid capabilities remain disabled until
explicitly enabled. With embedded job topology, `createEmbeddedJobRunner()`
returns the normal s-m-r-t `TaskRunner`, so the application keeps one enqueue
and execution contract without requiring a separate worker service.

### Moving, restoring and copying an installation

The seed (`secrets/application.secret`) *is* the installation: the device,
tenant, owner, profile and membership IDs and the keys of bootstrap and local
MCP tokens all derive from it, and it lives inside the data root. Anything that
copies the data root (`smrt app backup`, a synced folder, a manual `cp`) copies
the identity. Offline, a restore onto a new machine and a second active copy
are byte-identical, so the runtime never guesses between them (#4704).

**Decision.** Which *location* last took custody of a seed is recorded, and
every arrival it cannot attribute is refused until the operator says what it
is. Two records carry the evidence; neither holds secret material, and each
names the installation (the public device ID), an `epoch` that counts custody
transfers, and a random `activationId`:

- `<data root>/secrets/installation.json` travels with every copy.
- `<state root>/installation.json` stays at the location. The state root is
  derived from the data-root path and is outside the data root, so a copy never
  carries it.

Matching `activationId`s mean the data root was last activated here. Startup
(`initializeLocalApplicationRuntime`, under its initialization lock, before any
migration or table is touched) behaves as follows, with the `installation_*`
code in `LocalRuntimeError`:

| Situation | Status | Startup |
|---|---|---|
| First run, or a data root started fresh | n/a | Establishes custody, epoch 1 (a stale record for a deleted data root at this location is replaced) |
| Installation older than the records | `unrecorded` | Adopted at epoch 1 (trust on first use; a copy made before this feature cannot be told from the original) |
| Records agree | `in-custody` | Starts |
| Copy or move arrived (this location never activated it) | `arrived` | `installation_unverified` |
| Data root restored from another activation, an older backup, or another installation's backup put over this location | `diverged`, `data-record-missing` | `installation_unverified` (a first run that stopped between its two record writes is finished instead) |
| Location retired by `retire` | `retired` | `installation_unverified` |
| Seed differs from the recorded installation | `seed-mismatch` | `installation_unverified` |
| Record malformed, extended, oversized, a link or not private | `record-invalid` | `installation_unverified` |
| Seed file missing although the bootstrap table or the data root's custody record shows one existed | `seed-missing` | `installation_seed_missing`; the seed is **not** recreated |

A refusal changes nothing and never reaches the database schema or tokens. Only
a seed this very run created counts as new; a seed that already existed, even
beside an empty database, is judged like any arrival. The data record is the
authority on which installation a seed belongs to, so a seed that disagrees with
it is `seed-mismatch` even if another record is corrupted.

**Declarations** (exported functions; `smrt app installation <subcommand>`).
All require the application to be stopped (they take the writer lease and the
initialization lock) and print secret-free JSON that spells out the effects.
`status` (`inspectInstallationCustody`) never changes a custody record; like
startup it may create the private state directory and tighten the `secrets/`
directory mode:

| Declaration | Use it when | Seed | Identities | Seed-keyed tokens | Epoch |
|---|---|---|---|---|---|
| `restoreInstallation` (`restore --origin-retired`) | The same installation moved or was restored and the origin is stopped or deleted | kept | unchanged | still valid | +1 |
| `reseedInstallation` (`reseed`) | A copy whose origin stays active; a lost seed with no backup; planned rotation | **replaced** (old one not kept) | **device, tenant, owner, profile, membership derivations change** | **invalidated**; active local MCP tokens are revoked | 1 (`previousInstallationId` names the old one) |
| `recoverInstallationSeed` (`recover-seed <file>`) | The seed was lost or replaced and a backup exists | restored from backup, which must derive the recorded installation | unchanged | still valid | unchanged |
| `retireInstallation` (`retire`) | After moving away from this location | kept | unchanged | unchanged | unchanged; this location cannot start until `restore` |

`restore` requires the explicit assertion `originRetired: true`: the runtime
cannot see another machine, so it records the claim rather than verifying it.
A copy whose origin stays active must be re-seeded instead. Re-seeding keeps
all application data: existing rows keep the IDs they were created with and
only new derivations use the new seed, so the copy becomes a distinct sync
device. A pending owner invitation was keyed by the old seed; run
`smrt app recover` for a new one. Sessions are not seed-keyed and are not
revoked. `smrt app export` / `import` produce an independent installation by
construction (secrets are not exported; the target gets its own seed).

**Missing seed.** There is no server escrow. A backup of the seed restores
everything exactly (`recover-seed`); with no backup the seed is lost and the
only way forward is `reseed`, whose effects are the table above. The runtime
refuses to quietly mint a replacement because that would silently change every
derived identity and token key.

**Limits.** This is a local, cooperative control. A byte-identical clone of
both the data root and the state root (a VM or home-directory image), a copy
made before the records existed, and two operators who each assert `restore`
from one backup are not detectable offline; the later primary-writer relay
compares `epoch` and `activationId` to catch them (equal epochs with different
activations are a conflict). The state root is keyed by the data-root path as
spelled, so a differently cased alias of one macOS path is a different
location. Declarations run `smrt-app-runtime` code under the writer lease; keep
at most one SQLite writer on a data root (#3379).

### Local desktop MCP credentials

A desktop product can mount this opt-in SvelteKit route in
`src/routes/api/local/mcp-credentials/+server.ts`.

```ts
import { createLocalMcpCredentialHandler } from '@happyvertical/smrt-app-runtime/sveltekit';
import { runtime } from '$lib/server/smrt';

export const POST = createLocalMcpCredentialHandler(runtime);
```

Serve it on the desktop app's direct loopback listener, with the adapter's
socket peer address and request Host. Keep forwarded address, host, and
protocol configuration unset. Set adapter-node's
`ORIGIN` to the actual desktop URL, such as `http://127.0.0.1:4678`, because
adapter-node otherwise assumes HTTPS. The handler checks the socket peer,
loopback URL host, matching Host and exact Origin. When the browser
sends `Sec-Fetch-Site`, it must be `same-origin`. Call the endpoint from the
app's signed-in, same-origin desktop webview using its normal session cookie.
The session must use local bootstrap, password or passkey authentication,
have a direct active membership, and match the sole active system Owner
membership of the installation. Device, layered and permission-capped sessions
are rejected.

Send a JSON POST with an opaque lowercase UUIDv4 `id` generated by the
desktop app, a nonempty array of permission slugs, and an explicit integer
lifetime from 60 to 31,536,000 seconds.

```json
{
  "action": "put",
  "id": "2c70f518-b95a-445b-a75e-8126ae7c032a",
  "scopes": ["notes.read"],
  "expiresInSeconds": 3600
}
```

The first PUT creates the slot. A later POST with the same `action: "put"`
replaces its bearer, scopes and expiry atomically. Scopes must be held by
both the live owner and the authenticated session. Successful replies carry
`{ id, token, scopes, expiresAt }` in a private `Cache-Control: no-store`
response. Pass the bearer directly to native credential handling for the MCP
bridge. Keep it out of arguments, URLs, logs, browser storage, and generated
plugin artifacts. The installation secret stays on the server, and the
database stores only the bearer HMAC.

Persist the non-secret slot ID before the first request and serialize actions
per slot. A failed write preserves the previous credential. If the outcome is
unknown or the response is lost, repeat PUT with the same ID. Each successful
write produces a fresh credential, and only the latest committed write
verifies. A retry therefore recovers the slot without leaving an extra active
credential.

Send `{ "action": "revoke", "id": "<slot-id>" }` with an unrestricted owner
session to disconnect. Repeating it returns `{ "status": "revoked" }`.
Revocation is permanent for the slot even if a PUT was delayed or no PUT
completed, so use a new UUID to reconnect. The operator CLI can list or
revoke the stored UUIDv8 record. Desktop slots and manual CLI token IDs are
separate namespaces.

Failures carry a fixed `code` and no credentials. A revoked slot returns
`409 slot_unavailable`; validation failures return `400 invalid_request`
or `400 invalid_scope`; requests failing the trust checks return
`403 forbidden`. Deployed profiles return `404 unavailable` to requests
that reach the profile check.

## SvelteKit entry

`@happyvertical/smrt-app-runtime/sveltekit` composes the profile runtime,
tenant selection, the signed session, and authorized-tenant locals so an app's
server hooks are a few lines. `@sveltejs/kit` is an optional peer dependency;
the root entry never imports it.

```ts
// src/hooks.server.ts
import { createSmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';

export const runtime = createSmrtSvelteKitRuntime({
  prepareDatabase: runApplicationMigrations, // optional, idempotent
});
export const { handle, init } = runtime;
```

```ts
// src/app.d.ts
import type { SmrtRuntimeLocals } from '@happyvertical/smrt-app-runtime/sveltekit';
declare global {
  namespace App {
    interface Locals extends SmrtRuntimeLocals {}
  }
}
```

`init` is the fail-closed startup gate (local runtime or deployed bindings) and
`handle` waits for it, then runs, in order: URL tenant selection into
`locals.selectedTenant*` (never tenant context; tenant headers are ignored),
the signed session, and publication of `locals.tenantContext` only when the
active context matches the verified session tenant. A session's tenant is
accepted only for an active direct membership or a legitimately inherited
one (`isSessionTenantAuthorized()`, the same rule deployed `restoreSession()`
applies); otherwise the request is unauthenticated (no user, permissions,
tenant, or tenant context). `database-rls` isolation always runs the request
RLS transaction (`session.postgresRls` cannot disable it); a
`session.skipPaths` prefix skips session loading only and still runs inside
that transaction as an anonymous principal. During such a request
`runtime.classOptions()` / `runtime.databaseConfig()` return the
transaction-bound request database (unless the class has its own `db`
override), so call them per request and never retain the result. Downstream code runs
at most once: its error propagates unchanged, and a session-layer failure
before it returns 500 with no authenticated locals. Defaults read `SMRT_APP_ID`, `SMRT_DATA_DIR`, `HOST`, `DATABASE_URL`,
`TENANT_BASE_DOMAIN`, and `SMRT_BACKGROUND_JOBS`; `smrt.config` `runtime`
selects the profile (local when absent; a present `null`/`false`/`0`/`''`
fails closed, as in `smrt app`). Deployed profiles additionally require
`providerReadiness` probes and fail closed without them. In the local profile
the runtime holds the single-writer lease shared with `smrt app` operations by
default (`defaultWriterLease()`: `writer.lease` under
`prepareApplicationStateRoot()`, presenting `SMRT_OPERATION_INSTANCE`); pass
`acquireWriterLease` to replace it or `acquireWriterLease: false` to hold none.
Optional hooks: `onBootstrapInvitation` (present a newly issued setup token),
`selectTenant`, `session`, and `classOverrides`.
`runtime.getCollection(className)` returns the registered collection built
from `runtime.classOptions(className)` on that call. Each generated `/api/*`
route embeds a prelude that imports the app's `src/lib/server/smrt.ts` and
resolves collections through its exported `runtime` (core's
`createGeneratedCollectionAccess()`), so an app's `smrt.ts` is only the
runtime and its options. A legacy `getCollection`/`getSmrtConfig` export there
still takes precedence for one release, with a deprecation warning.

Mountable routes:

```ts
// src/routes/api/_runtime/health/+server.ts
export const GET = createRuntimeHealthHandler(runtime);
// src/routes/api/_runtime/diagnostics/+server.ts
export const GET = createRuntimeDiagnosticsHandler({ runtime, toolNames });
// src/routes/setup/+page.server.ts
export const { load, actions } = createOwnerSetupPage(runtime);
// src/routes/+layout.server.ts
export const load = createSessionLayoutLoad();
// src/routes/sign-out/+server.ts
export const POST = createSignOutHandler(runtime);
```

`createSessionLayoutLoad()` returns `session.user` (`{ id, email, name? }` or
`null`). `createSignOutHandler` accepts only same-origin `POST` (405 / 403
otherwise), destroys the session, clears the cookie, and answers 204 (303 to
`/` for HTML form posts).

Diagnostics authorize (owner role or `runtime_diagnostics.read` on an active,
session-matching membership) before reading the runtime and return only stable
`{ schemaVersion: 1, error: { code } }` failures. Owner setup is local-only and
re-checks on every request that both the peer address and the URL host are
loopback; its `default` action reads `token`, `name`, `email`, and optional `password` and
`tenantName`, sets the session cookie, and redirects 303, or returns
`fail(status, { code, message })` with `setup_disabled` (404),
`setup_unavailable` (403), `setup_invalid_input` (400), `setup_invalid`
(400), or `setup_conflict` (409, the `ownerTenant` slug already exists). Claim error text is never returned. After the claim commits, the
runtime removes the `smrt app setup` / `recover` hand-off files
(`ONBOARDING_HANDOFF_FILES`: `onboarding.json`, `onboarding-launch.html`) from
`runtime.applicationStateRoot()`, so `pnpm app:open` stops offering the spent
invitation; failed claims leave them untouched. `onOwnerClaimed` remains for
extra app cleanup and `removeOnboardingHandoff: false` opts out.

Password-based applications should pass `{ requirePassword: true }` to
`createOwnerSetupPage` and include a password field in their setup form. The
password is stored in the owner-claim transaction; a rejected password leaves
the token available for retry. Existing bootstrap consumers may omit it.
Use one server-only `PasswordPolicyOptions` value for bootstrap and sign-in,
including any pepper, length constraints, or custom rejection hook:

```typescript
const passwordPolicy = { pepper: serverSecrets.passwordPepper, minLength: 16 };
const runtime = createSmrtSvelteKitRuntime({ passwordPolicy });
const passwords = await PasswordCredentialService.create({
  ...runtime.classOptions('User'),
  password: passwordPolicy,
});
```

`initializeLocalApplicationRuntime` accepts the same `passwordPolicy` option.
It is never taken from form data or included in diagnostics. Bootstrap uses the
policy on its transaction-bound service, and registers password-management
permissions before seeding the owner's grants.

`resolveApplicationId()` and `runtimeConfigurationFingerprint()` (root entry)
are the canonical app ID and secret-free configuration fingerprint shared by
the web health route and process managers.

The root entry also owns the operator state shared with `smrt app`:
`prepareApplicationStateRoot()` (private, app-bound state directory),
`withOperationLock()`, `acquireWriterLease()` / `readActiveWriterLease()`,
and `createProviderReadinessProbe()`. The SvelteKit runtime takes the writer
lease itself; a SvelteKit app passes only the readiness probe and its own
options, without depending on the CLI:

```ts
// src/lib/server/smrt.ts
import { createProviderReadinessProbe } from '@happyvertical/smrt-app-runtime';
import { createSmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';

export const runtime = createSmrtSvelteKitRuntime({
  providerReadiness: createProviderReadinessProbe,
});
```

## Self-hosted and cloud applications

The deployed initializer validates the selected profile against concrete,
provider-owned bindings. Database URLs, OIDC credentials, storage keys, and
secret-manager identifiers stay inside those adapters and are never copied into
the runtime snapshot.

```ts
import {
  initializeDeployedApplicationRuntime,
} from '@happyvertical/smrt-app-runtime';
import { getDatabase } from '@happyvertical/sql';

const initialized = await initializeDeployedApplicationRuntime({
  profile: 'self-hosted',
  database: {
    engine: 'postgres',
    connect: () => getDatabase({
      type: 'postgres',
      url: requirePrivateSetting('DATABASE_URL'),
    }),
    close: async (db) => {
      await db.close?.();
    },
  },
  authentication: {
    provider: 'oidc',
    readiness: () => oidcProvider.assertReady(),
  },
  assets: {
    provider: 's3-compatible',
    readiness: () => assetProvider.assertReady(),
  },
  secrets: {
    provider: 'environment',
    readiness: () => secretProvider.assertReady(),
  },
  prepareDatabase: runApplicationMigrations,
});
```

Startup validates every binding, including the provider-owned database cleanup
boundary, before opening a connection. A missing public-auth or secret binding,
a selector mismatch, an unavailable provider, a failed
PostgreSQL probe, or a failed migration rejects startup. Provider failures are
reported with stable component codes and omit the underlying provider message
so credentials cannot leak into HTTP or orchestration payloads.
A custom database readiness callback is additive; the runtime always runs its
own PostgreSQL-specific server-version probe before startup or readiness can
succeed.
If cleanup after a startup failure also fails,
`DeployedRuntimeCleanupError.retryCleanup()` retains the redacted, idempotent
ownership path until the provider closes successfully.

`health()` reports process liveness. `readiness()` rechecks PostgreSQL,
authentication, assets, and secrets and returns only `ready` / `not-ready`
component states. `diagnostics()` reports the resolved profile, explicit
provider selectors, tenancy posture, and worker topology without secret values.

Job producers keep using `SmrtObject.bg()` / `background().enqueue()` in every
profile. Deployed worker entry points initialize the ordinary runners against
the same PostgreSQL database. A worker is a separate Node process, so it must
first import the application's compiled object registration —
`.smrt/runtime/register.js`, produced by a SvelteKit `smrtPlugin()` build — or
any job targeting an application object fails with `Unknown object type`:

```ts
await import('./.smrt/runtime/register.js');

const taskWorker = await initialized.createTaskWorker({ concurrency: 8 });
await taskWorker.start();

// Run this in a separate schedule-worker process, not beside the web server.
const scheduleWorker = await initialized.createScheduleWorker();
await scheduleWorker.start();
```

`initialized.close()` drains in-flight readiness/session/worker initialization
and serialized runner start/stop operations, stops every runner returned by
this runtime, and only then closes PostgreSQL.
Callers may stop a runner earlier, but must not restart a returned runner after
its runtime has begun shutdown; lifecycle-gated `start()` calls then reject.
An awaited `close()` request made from inside a tracked provider or worker
operation acknowledges shutdown so that operation can unwind; callers outside
the operation continue to await complete worker and database cleanup.

Self-hosted deployments may select OIDC, magic-link, or password authentication, explicit
single- or multi-tenancy, local or S3-compatible assets, and environment,
local-file, or external secrets. Cloud requires hosted identity, PostgreSQL,
multi-tenancy with required tenant context, managed/external secrets,
managed/S3-compatible object storage, public TLS, and scalable workers. Cloud
may select application isolation instead of PostgreSQL RLS, but it can never
enable an unscoped/root-tenant fallback.

The application runtime does not provision databases, buckets, identity
providers, secret managers, worker fleets, TLS, billing, or a hosted control
plane. Those remain operator/managed-platform responsibilities. Enabling the
`database-rls` selector also requires the deployment migration to apply the
documented s-m-r-t PostgreSQL policies; the selector does not grant or mutate
database privileges at runtime.

## Vault recovery key wrapping

The Node-only `@happyvertical/smrt-app-runtime/vault-recovery` entry can wrap a
32-byte vault data key with a recovery secret held by the user.
`wrapVaultRecoveryKey({ keyId, key }, recoverySecret, { accountId, generation })`
returns an opaque record. `openVaultRecoveryKey(record, recoverySecret, context)`
returns the authenticated key ID and key. Use a high-entropy passphrase or a
randomly generated printable recovery code. Keep the secret separate from the
wrapped record. Losing every authorized device and the recovery secret means
losing access to the data. These functions leave storage, device enrollment,
rotation, and revocation to their callers.

Supply the expected account and key generation from trusted local or pairing
state. The recovery record cannot establish which account or generation is
current. A holder of the wrapped record can try guesses offline, so callers
should run recovery locally after user action.

The v1 record starts with ASCII `HVRK`, the byte `01`, and a 16-byte random
salt. The rest is an uncompressed
[SDK v1 envelope](https://github.com/happyvertical/sdk/blob/v0.111.6/packages/encryption/README.md#vault-snapshot-envelopes).
Its plaintext is the 32-byte data key. The record has 195 bytes plus the
UTF-8 byte length of the account ID. Readers reject incompatible lengths and
envelope headers before deriving the wrapping key. The header carries the data key's ID
as 32 lowercase hex digits in the API. The authenticated context uses the
account ID, the fixed device slot `smrt-vault-recovery-v1`, and the unsigned
64-bit generation as the sequence. The wrapping key is 32 bytes derived
with scrypt (`N=131072, r=8, p=1`) from the secret and the salt prefixed
with ASCII `smrt-vault-recovery-v1`. The secret is encoded as 16 to 1024 bytes
of well-formed UTF-8 with no normalization or trimming.

## Vault device key wrapping

Use the Node entry `@happyvertical/smrt-app-runtime/vault-device-key` to wrap an
account data key on a device that already holds it. Pass a distinct, randomly
generated 32-byte device secret for each device. Keep the device secret in local
credential custody and store or transfer only the returned wrapped record.

`wrapVaultDeviceKey(dataKey, deviceSecret, context)` returns the record.
`openVaultDeviceKey(record, deviceSecret, context)` returns the 32-byte data key
after authentication. Supply `{ accountId, deviceId, generation, keyId }` from
trusted device state. The generation is an unsigned 64-bit bigint and the key
ID is 32 lowercase hex digits. The caller manages enrollment, storage, and
which generations are current. Removing a wrapped record cannot revoke a key
a device already recovered.

A v1 record starts with ASCII `HVDK` and the byte `01`. The remainder is an
uncompressed [SDK v1 envelope](https://github.com/happyvertical/sdk/blob/v0.111.6/packages/encryption/README.md#vault-snapshot-envelopes).
Its plaintext is the 32-byte data key. Its authenticated context uses the
account ID, device ID, and generation as the snapshot sequence. Its header
carries the data key ID. Derive the 32-byte wrapping key from the device secret
with [HKDF-SHA256](https://www.rfc-editor.org/rfc/rfc5869), an empty salt, and
ASCII `smrt-vault-device-key-v1` as the info string.

## Preparing a vault key generation

Use `prepareVaultKeyGeneration(options)` from
`@happyvertical/smrt-app-runtime/vault-key-generation` on the initiating
device. Supply the account and device IDs, the device's random 32-byte secret,
the user's recovery secret, and the current generation from trusted state.
Pass `currentGeneration: null` to prepare generation 1. The operation creates
a fresh key and ID, then returns the new context and both wrapped records
after both wraps succeed. The initiating device can open its record with
`openVaultDeviceKey`. A device using the recovery secret can open the recovery
record with `openVaultRecoveryKey`.

The result is a candidate for publication. A caller that persists it must
commit the records and context together, conditioned on the expected previous
generation. Concurrent preparations can produce different candidates for the
same next generation. Retain the wrapped keys needed to open existing
backups. Device enrollment and revocation have their own authorization and
storage requirements.
