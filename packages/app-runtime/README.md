# @happyvertical/smrt-app-runtime

Reusable infrastructure composition for s-m-r-t applications. The package
implements the validated profiles from `@happyvertical/smrt-config` without
forking domain objects, generated surfaces, effects, approvals, or job calls.

## Private local applications

```ts
import { initializeLocalApplicationRuntime } from '@happyvertical/smrt-app-runtime';

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
secret material. Placing this directory inside the source checkout is refused.

Owner onboarding binds to `127.0.0.1` by default and rejects non-loopback hosts.
The first valid claim creates a real global `Person`, `User`, default `Tenant`,
owner `Role` / `Membership`, and server-side `Session` atomically. Startup and
setup are idempotent; replayed, expired, or concurrent claims fail closed.

Background jobs and application-defined paid capabilities remain disabled until
explicitly enabled. With embedded job topology, `createEmbeddedJobRunner()`
returns the normal s-m-r-t `TaskRunner`, so the application keeps one enqueue
and execution contract without requiring a separate worker service.
