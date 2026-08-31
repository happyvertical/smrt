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
ownership, permissions, ACLs, or path components fail closed.

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
If cleanup after a startup failure also fails,
`DeployedRuntimeCleanupError.retryCleanup()` retains the redacted, idempotent
ownership path until the provider closes successfully.

`health()` reports process liveness. `readiness()` rechecks PostgreSQL,
authentication, assets, and secrets and returns only `ready` / `not-ready`
component states. `diagnostics()` reports the resolved profile, explicit
provider selectors, tenancy posture, and worker topology without secret values.

Job producers keep using `SmrtObject.bg()` / `background().enqueue()` in every
profile. Deployed worker entry points initialize the ordinary runners against
the same PostgreSQL database:

```ts
const taskWorker = await initialized.createTaskWorker({ concurrency: 8 });
await taskWorker.start();

// Run this in a separate schedule-worker process, not beside the web server.
const scheduleWorker = await initialized.createScheduleWorker();
await scheduleWorker.start();
```

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
