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

A refusal changes nothing and never reaches the database schema or tokens, and
its hint names only the declarations that accept that status (a `seed-mismatch`
is pointed at `recover-seed` or `reseed`, never at `restore`, which refuses it). Only
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
| `reseedInstallation` (`reseed --confirm-destroy-seed`) | A copy whose origin stays active; a lost seed with no backup; planned rotation | **replaced** (old one not kept) | **device, tenant, owner, profile, membership derivations change** | **invalidated**; active local MCP tokens are revoked | 1 (`previousInstallationId` names the old one) |
| `recoverInstallationSeed` (`recover-seed <file>`) | The seed was lost or replaced and a backup exists | restored from backup, which must derive the recorded installation | unchanged | still valid | unchanged |
| `retireInstallation` (`retire`) | After moving away from this location | kept | unchanged | unchanged | unchanged; this location cannot start until `restore` |

`restore` requires the explicit assertion `originRetired: true`: the runtime
cannot see another machine, so it records the claim rather than verifying it.
A copy whose origin stays active must be re-seeded instead. `reseed` is
irreversible (the seed is not kept, identities change and active local MCP
tokens are revoked), so it likewise requires an explicit
`confirmDestroySeed: true` / `--confirm-destroy-seed` even when the seed is
healthy, and refuses before touching any state without it; back up
`secrets/application.secret` first if you may need the old identity. Re-seeding keeps
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

**Containers and ephemeral homes.** The location's record lives in the state
root, `$XDG_STATE_HOME` (else `$HOME/.local/state`) plus
`/.<appId>-<hash of the data directory>-state`, on Linux; on macOS it is under
`~/Library/Application Support` and on Windows under `%LOCALAPPDATA%`, and
`XDG_STATE_HOME` is ignored there. A deployment that persists the data volume
but recreates `HOME` on every start loses that record: the first start
establishes custody, and the next start after the environment is rebuilt finds
a data root that arrived from nowhere (`arrived`) and refuses with
`installation_unverified`, with no way out except an operator running
`smrt app installation` by hand (a headless assertion is tracked separately in
#4823; it is deliberately not added here). So:

- **Set `XDG_STATE_HOME` to an absolute path on the same persistent volume as
  the data root** (outside the source tree and outside the data root itself) for
  every container that runs the local profile. Never leave it to `HOME` or
  `/tmp`. This is required, not a tuning option.
- Hosted deployments should keep the self-hosted runtime profile, which does not
  use the local runtime and does not read these records; no manifest should set
  the profile to `local` just to reuse the local runtime in a container.
- The refusal message names the state root and says whether it was derived from
  the home directory, so the cause is visible in the logs.

**Limits.** This is a local, cooperative control. A byte-identical clone of
both the data root and the state root (a VM or home-directory image), a copy
made before the records existed, and two operators who each assert `restore`
from one backup are not detectable offline; the later primary-writer relay
compares `epoch` and `activationId` to catch them (equal epochs with different
activations are a conflict). The state root is keyed by the data-root path as
spelled, so a differently cased alias of one macOS path is a different
location. Declarations run `smrt-app-runtime` code under the writer lease; keep
at most one SQLite writer on a data root (#3379).

### Vault primary writer and restore-latest

A vault account has one data line on the blind relay
(`@happyvertical/smrt-vault-relay`) and one primary writer at a time (#4805).
The relay holds the lease; this package holds the client side and the local
swap. There is no merge: a device that is behind must restore before it
writes.

- **Position** (`vault-sync-state.ts`): `<state root>/vault-sync.json` records
  the vault account, `baseSequence` (the snapshot this data root is at),
  `highestSeenSequence` (the downgrade floor, since the relay is untrusted;
  raised only from sequences this location published or restored, never from
  a lease grant's head, which can be an uncommitted hole or a hostile claim)
  and `localWritesPending`. It lives in the state root, so a copied data root
  cannot carry a forged position.
- **Lease keeper** (`vault-lease.ts`): `VaultLeaseKeeper` acquires the relay
  lease with the local base when the app starts writing against a vault
  account, renews at a third of the granted lifetime, and treats the lease as
  lost at its monotonic send time plus `ttlMs` minus a safety margin, never by
  comparing the relay's `expiresAt` with local time. Its states are `held`
  (writable), `must-restore`, `held-elsewhere`, `lost` and `unavailable`;
  `assertWritable()` throws `VaultLeaseError` with code `vault_lease_lost`, and
  `onChange` drives a visible read-only indicator. `recordPublished(sequence)`
  advances the position after a publish. The relay transport is injected
  (`VaultRelayTransport`), signed by the vault relay client.
- **Swap** (`data-root-swap.ts`): `swapDataRoot` replaces the live data root
  with a verified sibling candidate under an fsynced journal
  (`<state root>/data-root-swap.json`), rolling back to the previous root on
  any failure before the commit. While the journal exists,
  `acquireWriterLease` refuses every writer except the recovery path
  (`dataRootSwapRecovery`), so neither the web process nor an operator
  command can open or initialize a missing or half-swapped root.
  `recoverDataRootSwap` rolls an unfinished swap back or finishes a committed
  one; journal paths must be generated siblings of the live root.
- **Candidate check**: `inspectDataRootInstallation` judges a data root's own
  seed and custody record without a state root.
- **Retired locations**: `inspectLocationCustodyRecord` reads only this
  location's own custody record (`retired` after a move or a cloud migration,
  `invalid` when it cannot be trusted), so a restore can refuse before it
  touches a data root.

`smrt app restore-latest` (CLI) composes these: writer lease, refusal of a
retired or unverifiable location, of pending local writes and of downgrades, relay lease at the target sequence,
authenticated decrypt into a candidate, SQLite integrity and installation
checks, journalled swap, then the new position. Custody moves
(`restoreInstallation`) only on the operator's `--origin-retired`: releasing
the relay lease does not stop the origin device. A live root with no recorded
position counts as unpublished, and `removeStaleRestoreSiblings` clears
plaintext a crash left before the journal existed. Open: the SvelteKit request layer does not yet consult the
keeper; the desktop launcher wires `assertWritable()` into writes.

### Linking an installation to a hosted account

`smrt-cloud-link-v1` (#4806; design and security review on #4668) links a
local installation to a hosted account before a local-to-cloud migration.
Both halves are exported from this package; the migration itself is
`@happyvertical/smrt-cli/app` (`planCloudMigration` and friends).

- **Local** (`openLocalCloudLinkIdentity(options)`): refuses unless custody is
  `in-custody`; the one exception is `retiredInstallationId`, which lets a
  location retired for a per-user migration of that installation sign the
  per-user link of that migration (a per-user database is linked only after
  its import, and beginning retires the location first) and nothing else. It
  exposes the public device ID, the four seed-derived
  identities and an Ed25519 link public key derived from the seed under a
  purpose outside the public-UUID namespace. `signProof(challenge, expected)`
  first checks the challenge (`verifyCloudLinkChallenge`): normalized https
  origin equal to the one called, own application, installation and key, the
  operator's expected account **and** tenant IDs, a lifetime of at most ten
  minutes (60 s skew), a sole-member tenant for the per-user target, and an
  explicit `allowSharedTenant` when a shared tenant has other owners. The
  seed is re-read for the signature and never retained.
- **Hosted** (`createCloudLinkService({ origin, store })`): `origin` comes
  from configuration, never from request headers. The account, tenant,
  profile and membership come from the authenticated session
  (`CloudLinkPrincipal`), and only a tenant owner can link. A challenge is
  bound to that session and consumed by that session's first completion,
  whether or not the signature verifies; another session cannot burn it. The
  hosted identities are always the session's: on the per-user target the
  principal must be the imported local owner, tenant, profile and membership
  exactly (a per-user database is linked after its import). Links are unique per link public key: the same
  inputs return the same link; anything else is
  `installation_linked_elsewhere` (a copied seed that linked first is undone
  by `reseed`, which changes the key). Each account has at most five
  outstanding challenges. Every `CloudLinkStore` method is one atomic step:
  `insertChallenge` checks that cap and inserts together, `consumeChallenge`
  is a compare-and-set for the issuing session, and `createLinkIfAbsent`
  inserts only when no link exists;
  `createMemoryCloudLinkStore()` is for tests only.
- **Receipt**: `verifyCloudLinkReceipt` checks the returned link against the
  signed proof. `cloudLinkIdentityMap(link)` maps local to hosted
  identities (the identity on the per-user target) and system role IDs to
  themselves. H never authorizes anything on the claimed local identities.

Not yet provided: hosted HTTP routes, a durable hosted link store, unlinking.

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
losing access to the data. Storage, device enrollment, rotation, and
revocation are in [Vault key lifecycle](#vault-key-lifecycle).

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

## Device entitlement cache

A local install learns its tier offline from a signed, time-limited snapshot of
feature keys. The cloud/billing host signs it (Ed25519) from the account's
resolved entitlements; the install verifies it against public keys that ship
with the application and exposes the verified keys through `smrt-features`, so
`requireFeature()` works unchanged. Import from
`@happyvertical/smrt-app-runtime/device-entitlements`.

```ts
import {
  DeviceEntitlementCache,
  registerDeviceEntitlementGrantSource,
} from '@happyvertical/smrt-app-runtime/device-entitlements';

const entitlements = new DeviceEntitlementCache({
  filePath: join(stateRoot, 'entitlement.json'),
  // Public keys bundled with the app (key id -> SPKI PEM / JWK / KeyObject).
  trustedKeys: { 'issuer-2026-11': ISSUER_PUBLIC_KEY_PEM },
  accountId, // the signed-in account
  deviceId, // this device
  gracePeriodMs: 3 * 24 * 60 * 60 * 1000, // optional, default 0
  transport: async ({ accountId, deviceId, signal }) =>
    fetchSnapshotFromHostedEndpoint(accountId, deviceId, signal),
});

registerDeviceEntitlementGrantSource(
  entitlements.grantSource({ tenantId: localTenantId }),
);
await entitlements.refresh(); // verifies and stores; keeps the old one on failure
const status = await entitlements.status(); // { tier, state, reason?, featureKeys, ... }
```

- **Snapshot.** `{ accountId, deviceId, featureKeys, issuedAt, expiresAt, keyId }`
  (epoch milliseconds), serialized as `{ version, keyId, payload, signature }`
  where `payload` is base64url JSON and `signature` covers it under the domain
  prefix `smrt-device-entitlement-v1\0`. The issuing host calls
  `signDeviceEntitlementSnapshot(snapshot, privateKey)`; the private key never
  ships with an install.
- **Fail closed.** No snapshot, expired, tampered, signed by an unknown or
  wrong key, for another account or device, issued more than `clockSkewMs`
  (default 5 minutes, max 1 hour) in the future, longer than `maxLifetimeMs`
  (default 90 days), older than a newer one already accepted, or unreadable:
  the Local tier with no paid keys. Nothing throws; `status()` carries a reason
  code. Invalid configuration (for example a non-Ed25519 or private key in
  `trustedKeys`) throws when the cache is constructed.
- **Grace period.** `gracePeriodMs` (default 0, max 30 days) keeps the keys on
  after `expiresAt` for a device that cannot reach the host. The status is
  `state: 'grace'` with `graceEndsAt`. Clock skew is tolerated on `issuedAt`
  only; it never extends an expiry.
- **Replay.** The newest accepted `issuedAt` is kept in `<filePath>.watermark`,
  and both `install()` and `status()` compare against it. A user who deletes
  or corrupts the watermark (or both files) or sets the clock back can reuse a
  snapshot that has not expired; keep issued lifetimes short enough that this is
  acceptable. A snapshot carries at most 64 keys of 128 characters.
- **Trust.** The cache file and its directory are not trusted; the key set is.
  Ship the public keys in the application, not in the data root.
- **Identity inputs must be unforgeable.** `accountId` and `deviceId` are the
  only things that bind a snapshot to this install: a snapshot is accepted when
  its signed account and device equal the values passed in, and nothing else
  ties it to the machine. Take them from the installation's own identity (the
  signed-in account, the installation seed's derived device ID or the device
  key custody), never from a file, environment variable or setting the user or
  another local process can edit. If a copied cache file can be paired with
  edited identity values, it works on another machine until the snapshot
  expires (plus any grace period) and the keys it carries stay on for that long.
  Short issued lifetimes limit the exposure; they do not remove it.
- **Refresh.** The transport is injected (the hosted endpoint is not part of
  this package). Its result is verified like a file; a thrown, timed-out, forged
  or replayed answer leaves the stored snapshot in place.

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

## Vault key lifecycle

Use `createVaultKeyLifecycle({ store })` from
`@happyvertical/smrt-app-runtime/vault-key-lifecycle` to manage one device's
vault keys. It builds on the three entries above and adds device enrollment,
custody, rotation and revocation. The lifecycle runs one operation at a time.
Processes that share a store must serialize their calls, for example under
the application's operation lock.

### Account authority and signed heads

Account state moves between devices only in a signed **account head**. Account
state means the current key, a commitment to every data key, the active
devices and the revocations.

An Ed25519 **account authority** key signs every head. Its random seed is
wrapped under the recovery secret as an `HVRK` record at generation 0, called
the authority record. A device opens it only while the user has entered the
recovery secret. So a stolen device secret alone cannot:

- advance the generation,
- choose a key,
- add a device, or
- revoke one.

Only these operations sign a head, and each takes the recovery secret:

- `initializeAccount`
- `enrollDevice`
- `enrollFromRecovery`
- `rotate`

Heads are signed over a length-prefixed encoding with domain tags. Each data
key is committed with HKDF-SHA256 over the account, generation and key ID.
Each recovery record is committed by its SHA-256 digest. Keys are identified
by `(generation, keyId)`.

A device applies a head, from a grant or from
`acceptAccountHead(head, authorityRecord?)`, by these rules:

- **Newer head that contains the local one:** the device adopts it. Containing
  means it lists every key entry identically, every revocation, and every
  device as active or revoked.
- **Older head the local one contains:** it is stale and changes nothing.
- **Anything else:** it is fork evidence. The device keeps the evidence, and
  its revocations take effect at once. Sealing then fails with
  `generation_conflict` until the device adopts a head that contains the
  evidence. Any device can produce that head with
  `rotate({ recoverySecret })`, which merges every branch.
  - A device revoked on two branches keeps the earlier effective
    generation.
  - Two devices enrolled on different branches under one ID or key are both
    revoked; enroll the right one again.

A head that revokes the receiving device fails with `device_revoked`.

`accountHead()` returns the adopted head and authority record for the relay
to publish. The relay is blind and untrusted. It only carries heads, grants
and records.

A device opens the authority only from the stored record whose digest the
adopted head signs. A device that learns a head without that record cannot
sign until it receives the record, from `acceptAccountHead` or a grant.
Grants carry the record when the sender holds it, and enrollment grants
always do.

### Custody

`VaultKeyStore` is the custody seam: `get`, `set` and `delete` named byte
items, with atomic replacement. The desktop shell injects an OS keychain
provider. Headless and development installs use `createFileVaultKeyStore(dir)`
from `@happyvertical/smrt-app-runtime/vault-key-store`.

- The directory must be absolute. It is created with mode 0700 and must be a
  real directory owned by the current user.
- Items are mode 0600 files replaced by atomic rename.
- On Windows, POSIX modes are synthetic and there is no uid, so the file
  store performs no custody check. Place the directory under the user's
  profile, and prefer the shell's keychain provider there.
- Keep the directory outside the application state root, so plain-data
  exports and backups never include it.

The store holds the following:

- the device secret
- per key, the device's wrapped record (`key.<generation>.<keyId>`) and the
  recovery record (`recovery.<generation>.<keyId>`)
- the authority record
- the device registry

The registry holds only IDs, digests, signatures, timestamps and public keys.
Secrets and wrapped keys never pass through process arguments.

The lifecycle zeroes the device secret and authority seed after each
operation. Callers must zero the `key` bytes returned by `openSealingKey` and
`openReadingKey`. JavaScript strings cannot be zeroed, so drop references to
the recovery secret promptly.

Errors are `VaultKeyLifecycleError` values with a stable `code` and a fixed
message.

### Sealing and reading

- `openSealingKey()` is the only path for sealing new data. It refuses with:
  - `rotation_required` while a local revocation is pending
  - `generation_conflict` after fork evidence
  - `key_missing` when the device does not yet hold the current key

  It never falls back to an older key.
- `openReadingKey({ generation, keyId })` opens a held key named by stored
  data. It is not gated, because reading old data during a pending rotation
  is legitimate. Never seal with it.

An encrypted-snapshot `SnapshotKeyProvider` maps onto the lifecycle as
follows. `createLifecycleSnapshotKeys({ lifecycle, nextSequence })` in
`@happyvertical/smrt-cli/app` implements this mapping:

- `sealingKey()` takes the key from `openSealingKey()` and adds the snapshot
  sequence from `nextSequence()`. The gate runs first, so a refused seal
  (`rotation_required`, `generation_conflict`, `key_missing`,
  `not_initialized`) spends no sequence and writes no file. It never calls
  `openReadingKey` and never falls back to an older generation.
- `openingKey(ref)` checks `ref.accountId` against `status().accountId`, then
  returns `(await openReadingKey(ref)).key`, or `undefined` on `key_missing`.
- `snapshotAccountTrustFromLifecycle(lifecycle)` reads the adopted head for
  restore-latest: the revoked device ids and a generation floor (the highest
  `effectiveGeneration` of any revocation). A revoked device keeps every key
  below that generation, so snapshots under it cannot be told from forgeries.

### Enrollment

1. The new device calls `createEnrollmentRequest({ accountId, deviceId })`.
   It returns the request and a device code. The request holds the device's
   X25519 public key, a random nonce and an `expiresAt` at most 15 minutes
   ahead (default 10). It is not secret. Show it, for example as a QR code,
   together with the device code.
2. The enrolled device calls `enrollDevice(request, { confirmationCode,
   recoverySecret })`. The user types or confirms the device code from the
   new device's screen. On a code mismatch, an expired request or a wrong
   secret, it writes nothing. Otherwise it signs a head that adds the
   device. It returns the grant and an account code.
3. The new device calls `acceptEnrollment(grant, { confirmationCode })` with
   the account code read from the enroller's screen. It accepts only:
   - a grant for its own unexpired request,
   - whose head lists both devices, and
   - whose keys match the head's commitments.

Each code is 12 base32 characters (60 bits) derived from the request nonce:

- The device code binds the account, device ID, public key and expiry. So a
  relay cannot substitute the new device's key.
- The account code binds the authority key, the signed head and the new
  device's key. So someone who sees the QR code cannot pull the device into
  another vault.

Each data key in a grant is sealed to the recipient with
`sealVaultDeviceTransfer` from
`@happyvertical/smrt-app-runtime/vault-device-transfer`. The seal combines an
ephemeral and a static X25519 agreement through HKDF-SHA256. The HKDF info
binds the sender ID, both public keys, the ephemeral key and a SHA-256 digest
of every other grant field, including the head and the authority record. A
change to any of them fails authentication.

The resulting key wraps the data key as an `HVDK` record behind the `HVDT`
`01` prefix and the ephemeral public key. The authenticated context binds
the account, the recipient device, the generation and the key ID. The device
secret never leaves the device: the X25519 private key is derived from it
with HKDF info `smrt-vault-device-agreement-v1`.

Devices learn of each other only from signed heads. A device enrolled
anywhere reaches every peer with the next head or grant. Rotation then seals
for every active device in its head.

On a fresh machine, use `enrollFromRecovery({ accountId, deviceId, head,
authorityRecord, recoveryRecord, recoverySecret })`. Take the head and
records from the relay. The call checks the following:

- the head's signature against the authority opened with the secret
- the recovery record against the head's digest
- the recovered key against the head's commitment

It then signs a head that adds the device. The generation and key ID come
only from the head.

**Trust requirement:** the relay must serve the latest head. An older
authentic head cannot be detected until the device meets a peer. At that
point it surfaces as a fork on both sides. Until then the device may seal
under a stale generation. Show the head's `headIssuedAt` and
`headIssuerDeviceId` from `status()` and ask the user to confirm them before
writing.

### Rotation and revocation

`rotate({ recoverySecret, newRecoverySecret? })` opens the authority with the
recovery secret before it changes anything. It then:

1. prepares the next generation with `prepareVaultKeyGeneration`
2. records the candidate and writes its records
3. signs and commits a head that makes every pending revocation effective at
   the new generation
4. returns the head, the authority record, the new recovery record and one
   update grant for each other active device

A crash at any point leaves the adopted head usable. The next `rotate` call
resumes a complete candidate or replaces an incomplete one. A head holds at
most 1024 key entries. Past that, `rotate` refuses with `generation_limit`.

Passing `newRecoverySecret` re-wraps the same authority seed and wraps the
new recovery record under the new secret. Peers receive the new authority
record with the grant, and only the new secret then authorizes changes. Older
recovery records stay under the old secret.

The relay keeps old authority records, so a **leaked** secret keeps its
authority. Today the remedy is a new account. Authority re-keying is tracked
in #4807.

`revokeDevice(deviceId)` needs no secret. It records a local pending
revocation, so this device refuses to seal (`rotation_required`) and refuses
to enroll until a `rotate` publishes the revocation. Other devices keep
sealing until they receive that rotation. Unsigned revocations are never
broadcast, because a stolen device could use them to lock the others out.

A pending revocation clears only when an adopted head revokes that exact
device ID and public key. If another device rotates without having seen the
local revocation, its new key still reaches the device you meant to revoke.
Rotate from the device that revoked.

A revoked device gets no new generation. Peers reject its grants once they
know of the revocation. It keeps any generation it had already opened.
`recoveryRecord({ generation, keyId })` returns a held recovery record for
publication.

### Threat model notes

- Whoever holds the recovery secret is the account. Typing it on a device
  gives that device's malware authority.
- A stolen device secret alone can only replay authentic heads and keys, or
  send grants that are rejected.
- Concurrent changes by two holders of the recovery secret fork the account.
  Sealing stops until a merge rotation.

### Product rules

Losing every enrolled device and the recovery code means losing the data.
HappyVertical holds no escrow copy of any key and cannot recover it.
