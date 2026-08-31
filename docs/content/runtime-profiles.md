---
title: Application runtime profiles
---

# Application runtime profiles

An s-m-r-t application declares one infrastructure profile and keeps the same
domain objects, workflows, generated interfaces, and approval policy when it
moves between a laptop and a deployment.

```ts
import { defineConfig } from '@happyvertical/smrt-config';

export default defineConfig({
  runtime: { profile: 'local' },
});
```

At startup, call `resolveConfiguredApplicationRuntime()`. It composes the loaded
file with highest-priority `setConfig()` overrides, then returns a deterministic,
immutable, machine-readable snapshot for startup, `doctor`, tests, and agent
inspection. It reads no environment variables and contains no connection
strings, paths, credentials, or secret values. Use
`resolveApplicationRuntime(config)` only when resolving an explicit value, such
as a test fixture; `getConfig()` retains its legacy loaded-file-only semantics.

## Safe presets

| Profile | Default composition | Supported choices |
| --- | --- | --- |
| `local` | user-owned SQLite; single-use owner bootstrap; real default tenant; local assets and secrets; embedded jobs; loopback binding; file-snapshot backup | jobs may run `inline`; TLS may be enabled while the bind remains loopback |
| `self-hosted` | operator PostgreSQL; OIDC; single tenant; S3-compatible assets; environment secrets; external workers; public TLS; operator backup | magic link auth; explicit multi-tenant mode with required context; local or S3-compatible assets; environment, local-file, or external secrets; application isolation or RLS |
| `cloud` | managed PostgreSQL; hosted identity; required multi-tenant context with RLS; managed storage and secrets; scalable workers; public TLS; managed backup | S3-compatible storage, external secret provider, or application-enforced isolation |

All three presets advertise logical export and import. Provider-specific
settings such as database URLs, asset roots, OIDC credentials, and secret
manager identifiers remain in the owning provider's configuration. The runtime
snapshot intentionally reports only safe selectors and derived capabilities.

## Explicit overrides

Profiles are presets, not environment-name conditionals. Apply supported
provider changes in one place:

```ts
export default defineConfig({
  runtime: {
    profile: 'self-hosted',
    providers: {
      authentication: { provider: 'magic-link' },
      tenancy: { mode: 'multi-tenant', context: 'required' },
      assets: { provider: 'local-files' },
    },
  },
});
```

The resolver reports effective changes under `diagnostics.overrides`. Unknown
fields and incompatible combinations fail before application startup with a
path, reason, and recovery action. For example, local owner bootstrap cannot be
combined with a public bind, and cloud mode cannot disable required tenant
context or TLS.

When a runtime override selects a different profile, file-level provider
overrides are discarded before the new preset resolves. This prevents a local
choice such as inline jobs or local files from leaking into a cloud composition.
The same reset applies when successive `setConfig()` calls explicitly change
profile. When the profile stays the same, nested provider overrides deep-merge
normally.

## Cross-profile invariants

Provider selection cannot change these application behaviors:

- domain models and workflows;
- generated REST and CLI surfaces;
- generated MCP and WebMCP definitions;
- action-effect metadata and human approval policy;
- real authorization records;
- the job invocation API;
- logical export/import portability.

The resolved snapshot includes these invariants so integration tests can compare
profiles directly. Implementing packages consume the contract; templates should
never copy profile conditionals into application code.

## Running the local profile

`@happyvertical/smrt-app-runtime` implements the private local composition. The
application supplies its normal idempotent migration hook; the runtime prepares
the user-owned filesystem, securely acquires and tunes file-backed SQLite,
creates local application-secret material, and issues the first short-lived
onboarding token.

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
```

The default root is the operating system's per-user application-data directory,
never the source checkout, one of its ancestors, the user home itself, or the
filesystem root. The application root is a dedicated directory; when an
explicit root already exists, it must already be
owned by the current user with mode `0700`, and a failed proof leaves its mode
and contents untouched. Directories are mode `0700`; the database and
generated application-secret file are mode `0600`. SQLite enables foreign keys,
WAL, full synchronous durability, and a busy timeout. The local server binds to
`127.0.0.1` by default, and owner bootstrap refuses a non-loopback bind.
Initialization walks every existing storage-path component without following
symbolic links, verifies canonical source-tree separation, and performs chmod
through validated file descriptors. A platform without the required no-follow
file and directory semantics is refused rather than initialized unsafely. After
establishing its mode-0700 data root, the runtime acquires SQLite through the
`@happyvertical/sql` `node:sqlite` trusted-parent custody boundary. That boundary
rejects unsafe ownership, write permissions, static links, macOS ACLs, and
unsupported platforms or Node runtimes before opening the database.
It protects the custodied directory from other OS principals, not hostile code
already running as the same user; that stronger boundary requires OS sandboxing
and a descriptor-relative SQLite VFS.

Only an HMAC of the onboarding token is stored. The plaintext is returned once,
expires within fifteen minutes, and is consumed in the same serialized database
transaction that creates the real global `Person`, `User`, default `Tenant`,
owner `Role` / `Membership`, and server-side `Session`. Repeated setup or startup
does not duplicate those records. Tenancy can remain hidden in the local UI, but
the durable default tenant is preserved for later logical migration.

Background work and application-defined paid capabilities are disabled by
default. An explicit background opt-in exposes the regular embedded
`TaskRunner`, preserving the same persisted enqueue and execution contract used
by deployed workers. Diagnostics report these choices and bootstrap state but
never read or emit application secrets, token plaintext, or token hashes.
