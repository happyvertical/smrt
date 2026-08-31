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

The default data directory is the current user's OS application-data directory
(`~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows, or
`$XDG_DATA_HOME` / `~/.local/share` on Linux). It contains a mode-0600 SQLite
database, a user-owned asset directory, and generated mode-0600 application
secret material. The root must be a dedicated application directory: placing
it inside the source checkout or choosing an ancestor of the checkout is
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
Initializers for the same data root are serialized across processes by a
kernel-owned Unix socket in a private per-user lock directory. Live ownership
does not depend on PIDs, so PID reuse is irrelevant; after a process crash, a
failed connection proves the remaining socket pathname stale before it is
reclaimed. Marker cleanup therefore cannot race another active initializer.
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

Owner onboarding binds to `127.0.0.1` by default and rejects non-loopback hosts.
The first valid claim creates a real global `Person`, `User`, default `Tenant`,
owner `Role` / `Membership`, and server-side `Session` atomically. Startup and
setup are idempotent; replayed, expired, or concurrent claims fail closed.
Authenticated session TTLs are configured in whole seconds with a minimum of
one second, and invalid values are rejected before filesystem mutation.

Background jobs and application-defined paid capabilities remain disabled until
explicitly enabled. With embedded job topology, `createEmbeddedJobRunner()`
returns the normal s-m-r-t `TaskRunner`, so the application keeps one enqueue
and execution contract without requiring a separate worker service.
