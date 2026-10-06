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
exclusive transaction in a dedicated SQLite lock database under a private
per-user, root-keyed custody directory. The released `@happyvertical/sql`
trusted-parent boundary validates that directory, its ancestors, and the lock
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
The first valid claim creates a real global `Person`, `User`, default `Tenant`,
owner `Role` / `Membership`, and server-side `Session` atomically. Startup and
setup are idempotent; replayed, expired, or concurrent claims fail closed.
Authenticated session TTLs are configured in whole seconds with a minimum of
one second, and invalid values are rejected before filesystem mutation.

Background jobs and application-defined paid capabilities remain disabled until
explicitly enabled. With embedded job topology, `createEmbeddedJobRunner()`
returns the normal s-m-r-t `TaskRunner`, so the application keeps one enqueue
and execution contract without requiring a separate worker service.

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
```

Diagnostics authorize (owner role or `runtime_diagnostics.read` on an active,
session-matching membership) before reading the runtime and return only stable
`{ schemaVersion: 1, error: { code } }` failures. Owner setup is local-only and
re-checks on every request that both the peer address and the URL host are
loopback; its `default` action reads `token`, `name`, `email`, and optional
`tenantName`, sets the session cookie, and redirects 303, or returns
`fail(status, { code, message })` with `setup_disabled` (404),
`setup_unavailable` (403), `setup_invalid_input` (400), or `setup_invalid`
(400). Claim error text is never returned. After the claim commits, the
runtime removes the `smrt app setup` / `recover` hand-off files
(`ONBOARDING_HANDOFF_FILES`: `onboarding.json`, `onboarding-launch.html`) from
`runtime.applicationStateRoot()`, so `pnpm app:open` stops offering the spent
invitation; failed claims leave them untouched. `onOwnerClaimed` remains for
extra app cleanup and `removeOnboardingHandoff: false` opts out.

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

Self-hosted deployments may select OIDC or magic-link authentication, explicit
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
