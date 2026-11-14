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
    createSchema: true, // create the framework schema on first start
    prepareDatabase: runApplicationMigrations,
  });

// Show bootstrap.token only in the loopback onboarding URL. The plaintext is
// returned once and only its HMAC is persisted.
```

### First start: the app sets up its own database

With `createSchema: true` (the default of `createSmrtSvelteKitRuntime`; off by
default for a direct `initializeLocalApplicationRuntime` call, so operator
tooling that migrates through `smrt db:migrate` is unchanged), the local
runtime creates the schema on the first start of an empty data directory
instead of exiting with `DB_SCHEMA_MISSING` (smrt#4835). It happens after
custody has passed and inside the initialization lock, so two starts cannot
race (the SvelteKit runtime also holds the writer lease), and it uses the
framework's own migration path (`migrateSmrtSchemas` from
`@happyvertical/smrt-core/migrations`, recorded in `_smrt_schema_migrations`),
not a second schema creator. A second start finds nothing to apply. Upgrades
take the same path on every start. Deployed profiles (`self-hosted`, `cloud`)
never create schema: they keep failing with `DB_SCHEMA_MISSING` and migrate
through `smrt db:migrate`.

```ts
export const runtime = createSmrtSvelteKitRuntime({
  // Runs on EVERY start, after the framework schema, inside the same lock and
  // transaction. Must be idempotent; use it to seed or add the app's own steps.
  prepareDatabase: async (db, { firstRun, paths, migrateSchemas }) => {
    await db.query('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY)');
    if (firstRun) await seedWelcomeNote(db);
  },
});
```

`prepareDatabase(db, context)`: `context.db` is the same handle as `db` (on a
first run, the transaction handle), `context.profile`, `context.paths` (the
resolved local paths, `null` on a deployed profile), `context.firstRun` (true
only on the start that found no framework schema and no earlier runtime
initialization) and `context.migrateSchemas()` (the framework runner bound to
`db`; creates missing tables, and reshaping an existing table remains
`smrt db:migrate`). A hook that only needs the database may take `(db)`.

**Atomicity.** On a first run the framework step and `prepareDatabase` run in
ONE transaction. If either fails the transaction rolls back and, because this
attempt created the database file, the file and its `-wal`/`-shm`/`-journal`
side files are removed: no half-created database is left, and the same data
directory is retried as a first run. The private data directory, root marker
and application secret the attempt created stay (they hold no application
data and a retry reuses them). A crash mid-run is rolled back by SQLite on
the next open. On later starts (an upgrade) the framework batch is a single
atomic DDL transaction on the database, so a failed batch changes no table;
`prepareDatabase` then runs in its own transaction and rolls back on failure.
A failed upgrade batch leaves a `failed` row in `_smrt_schema_migrations`, as
`smrt db:migrate` does; a framework upgrade that already committed is kept if
the application's step then fails.

**Failure codes.** Both surface as `LocalRuntimeError` with fixed, path-free,
SQL-free text; the original error is a non-enumerable `cause` for private logs.

| Code | When | Message constant |
| --- | --- | --- |
| `schema_creation_failed` | the framework step (creation or upgrade) failed | `SCHEMA_CREATION_FAILED_MESSAGE` |
| `migration_failed` | the application's `prepareDatabase` rejected | `MIGRATION_FAILED_MESSAGE` |

Startup fails, the process exits non-zero, and the code and message are in the
process output (the error is thrown from `init`), which is what the desktop
wrapper reads on a failed sidecar start. Startup releases the database handle,
the initialization lease and the writer lease, so the same application root and
data directory remain retryable once the cause is fixed.

The path resolver selects the current user's OS application-data directory
(`~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows, or
`$XDG_DATA_HOME` / `~/.local/share` on Linux). On macOS and Linux, secure
initialization requires Node to expose nonzero `O_NOFOLLOW` and `O_DIRECTORY`
filesystem flags and fails closed without them. Windows has its own custody
rule (see [Windows](#windows)); the database opens there through
`@happyvertical/sql`'s `windowsCustody.verify`. The data root contains a mode-0600
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

### Windows

Node exposes neither `O_NOFOLLOW`, `uid`, nor mode bits on Windows, and it cannot
read an owner or a DACL, so POSIX custody does not translate. Windows has its
own, explicit rule (smrt#4837). It is implemented in `src/windows-paths.ts`
(lexical), `src/windows-sddl.ts` (SDDL parser and access decision),
`src/windows-acl-inspector.ts` (PowerShell attestation) and
`src/windows-custody.ts` (chain walk, creation, identity); every filesystem and
ACL effect goes through one seam, so the whole rule is tested on any platform
with an in-memory machine and, separately, on a real runner.

**Status.** The initialization lease, the operator state root
(`prepareApplicationStateRoot`, writer lease, operation lock), the read-only
preflight, `validateLocalDatabaseStorage()` and **database acquisition** work
on Windows. `prepareLocalDatabaseStorage()`,
`initializeLocalApplicationRuntime()`, `openLocalMcpTokenStore()` and the
SvelteKit runtime open SQLite through `@happyvertical/sql` (>= 0.111.8,
sdk#1498) with `secureFile: { driver: 'node:sqlite', custody: 'trusted-parent',
root, windowsCustody: { verify } }`. Node cannot read NTFS ACLs, so the SDK
owns only the structural walk (lexical containment, no links, canonical
`realpath`, regular leaf with one link, stable leaf identity) and hands the
trust decision to the caller: `verify(paths)` receives the drive-root-to-parent
chain and, when the file exists, the database file last. It runs before and
after the SDK creates a missing file, and again for an existing file after its
identity is recorded; if it throws, the SDK refuses and removes a file it just
created. The runtime's `verify`
(`createWindowsDatabaseVerifier()`, `windows-custody.ts`) accepts only the
database's own chain (anything else throws), then applies the **unchanged**
rule below: W3/W4/W6 on every component (custodied from the data root down,
ancestors under the looser ancestor rule) and on the database file, plus W5
(regular file, one link). It throws a `LocalRuntimeError`; it never returns a
verdict. The SDK wraps that failure as `Secure SQLite Windows custody
verification failed` (the original message is kept in `originalError`).
`windowsSecureFileCustody()` adds the option only when the custody platform is
`win32`, so the options a macOS or Linux host passes are unchanged.

The rest of the Windows acquisition uses the same rule in place of
`O_NOFOLLOW`, uid and mode bits: `acquireLocalDatabase()` prepares the data
root with `preparePrivateWindowsTree()` (directories it creates are locked and
re-inspected, or removed again), keeps the pending/final root markers,
and `prepareLocalFilesystem()` does the same for `assets` and `secrets`. The
application secret is written to a temporary file and published with an
exclusive hard link (so a crash leaves no partial secret), then read back
through the identity-checked handle with one link and the custodied ACL. There
is no mode to repair; the DACL is the guarantee.

The `smrt app` local-profile commands are no longer refused on Windows. The
`backup`, `export` and `import` copies still are
(`WindowsOperatorCopyUnsupportedError`): their refusal is about the
**destination**, not the database, because they copy the application secret and
database into a destination whose privacy relies on POSIX modes that Windows
ignores (the copy would inherit the destination folder's ACL). Lift that
refusal only with a destination custody rule for the copy.

**The rule.** A path is in Windows custody only when all of this holds:

1. **Lexical (W1).** The only accepted form is `X:\seg\seg` (forward slashes
   are converted). UNC (`\\server`, `\\wsl$`, `\\wsl.localhost`), `\\?\`,
   `\\.\`, drive-relative `X:foo`, rooted `\foo`, `.`/`..`, `:` anywhere after
   the drive (alternate data streams, `::$DATA`), `< > " | ? *`, control
   characters and NUL, segments ending in a dot or space, and the device names
   `CON PRN AUX NUL COM0-9 LPT0-9 COM¹²³ LPT¹²³ CONIN$ CONOUT$` (with or without
   an extension) are refused. The path plus the longest path the runtime derives
   beneath it must stay within 240 UTF-16 units, so nothing depends on
   `LongPathsEnabled`. The same segment rule applies to `appId` on Windows only:
   `con`, `nul`, `com1`, `con.app` and `foo.` are valid POSIX ids but name a
   device or alias another directory there.
2. **Base directory (W2).** The default root is `%LOCALAPPDATA%\<appId>`. A
   missing, relative, UNC or `\\?\` `LOCALAPPDATA` is an error. The runtime
   never falls back to the roaming `APPDATA` (which can be folder-redirected to
   a network share) or to the home directory; the operator state root and the
   desktop wrapper use the same machine-local base.
3. **No reparse point (W3).** Every component from the drive root to the leaf is
   a real directory (a regular file for the leaf of a file check): not a
   symbolic link or junction (`lstat`) and without the `ReparsePoint` attribute,
   which also catches volume mount points and cloud placeholders. Custodied
   entries must not be `Offline` or recall-on-access.
4. **Canonical identity (W4).** `realpath.native` of each component must equal
   the component, compared ordinally except for the drive-letter case. That
   refuses junction ancestors, `subst` and mapped drives, 8.3 short names and
   user-typed case variants of an existing directory (it fails closed rather
   than folding case). Case folding is used only where a merge is the safe
   direction: the writer-lease key, the state-root identity and the overlap
   guards.
5. **Handle identity (W5).** `O_NOFOLLOW` cannot be passed from Node on Windows,
   so a followed link is *detected*: an opened file must match `lstat` on bigint
   `dev`, `ino` and `birthtimeNs` and kind (NTFS file ids routinely exceed
   2^53, so the `number` form would lose the difference), before and after the
   open, and must have exactly one link. The `lstat` identity of every chain
   component is re-read after its ACL is inspected.
6. **Access control (W6).** This is the actual custody property; nothing above
   is a guarantee without it, because a directory created under `C:\` inherits an
   ACE that lets every local user modify it.
   - *Trusted principals:* the current user, `SYSTEM` and `BUILTIN\Administrators`
     (trusted the way uid 0 is on POSIX; objects created by an elevated admin are
     owned by Administrators). Ancestor owners may also be `TrustedInstaller`.
     SDDL writes the machine's built-in RID-500 `Administrator` as the alias
     `LA`, not as its SID, so when the current user's SID is a machine-account
     SID ending in `-500` (a runner's `runneradmin`, or a renamed built-in
     Administrator) `LA` is the same principal and is trusted too; for any other
     user `LA` is refused. A domain `Administrator` (`S-1-5-21-<domain>-500`)
     matches the same shape, so for that user a local `LA` entry is accepted as
     well; the local built-in Administrator is a member of
     `BUILTIN\Administrators`, which is trusted already.
   - *Custodied* (the data root and everything under it, the lease directory and
     file, the state root and its files): the owner is trusted, a DACL is
     present (a NULL DACL is refused), and every allow ACE names a trusted
     principal or `OWNER RIGHTS`. Inherit-only allow ACEs may also name
     `CREATOR OWNER`. Deny ACEs are accepted. Any other ACE type (object,
     conditional, callback, audit) or anything the parser does not recognise is
     refused.
   - *Ancestors* above the custody root: the sticky-directory analogue. A
     principal that is not trusted must not hold `DELETE`, `WRITE_DAC`,
     `WRITE_OWNER`, `FILE_DELETE_CHILD`, `GENERIC_ALL` or `GENERIC_WRITE`;
     creating siblings (`FILE_ADD_FILE`, `FILE_ADD_SUBDIRECTORY`) is tolerated,
     because it cannot replace our child.
   - *Creation and locking (smrt#4843):* when the runtime creates the private
     directory itself (the data directory, the lease directory, the state
     root) it locks it at once instead of keeping whatever the parent grants:
     inheritance is disabled and the DACL is replaced with exactly three allow
     entries, each full control with object and container inheritance, for the
     current user, `SYSTEM` (`S-1-5-18`) and `Administrators`
     (`S-1-5-32-544`). Only a directory this call created is ever locked, never
     one that already existed and never an ancestor such as `AppData\Local`.
     The lock is
     `<SystemRoot>\System32\icacls.exe <path> /inheritance:r /grant:r
     *<userSid>:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F`: an
     absolute executable, a fixed argv array in which the path is exactly one
     element (no shell, no string-built command, SIDs rather than localised
     names), the same allow-listed environment as the inspector (no `PATH`),
     10 s and 64 KiB bounds, and `shell: false`. A non-zero exit, a timeout or
     a missing or blocked `icacls.exe` removes the new directory and fails
     closed. The current user's SID comes from the inspector's answer for the
     existing chain. Nothing is written into the directory until it is locked,
     and one that was swapped for a link or another object around the lock is
     refused. **Residual race:** creating and locking are two steps, so the new
     (empty) directory briefly has the DACL it inherited; a principal that
     inherits access can list or open it in that window, and Windows offers no
     way to create a directory with a DACL in a single call from Node. Nothing
     sensitive exists in it yet.
   - *Verification:* every component the runtime creates is then re-inspected
     under the custodied rule (the lock does not replace the check). On failure
     exactly the components that attempt created are removed and the call
     fails closed; pre-existing components are never removed. Every directory
     the call creates is locked (intermediate ones too); only components that
     already existed keep what they inherited and must satisfy the rule as they
     are.
   - *Pre-existing directories:* verified, never re-permissioned. One that
     fails the rule is refused with an error that names the extra principal
     (its SID, plus a name when it is a well-known one such as Everyone,
     Authenticated Users or `BUILTIN\Users`; the inspector does not translate
     other SIDs, so run `icacls <directory>` to see who it is) and says how to
     fix it: move the data directory somewhere only you, SYSTEM and
     Administrators can access, or remove that access yourself. For example,
     `Local runtime path lacks Windows custody (custodied): C:\...\MyApp:
     access is granted to S-1-5-21-...-1003. The runtime never changes the
     permissions of an existing directory. Move the data directory ...`.
   - *Volume:* a local fixed disk (`Win32_LogicalDisk.DriveType` 3) formatted
     NTFS. FAT32, exFAT, network, removable and RAM drives have no usable ACLs.
     ReFS is refused for now (its 128-bit file ids are not handled).
7. **Explicit roots.** An explicitly configured root that already exists must
   already satisfy W6. The runtime only verifies an existing directory; it never
   edits its ACL (it only locks directories it creates, see *Creation and
   locking*). To prepare a private root by hand, run (substituting the path):

   ```bat
   mkdir D:\Apps\MyApp
   icacls D:\Apps\MyApp /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"
   ```

**The attestation.** Node cannot read a DACL, so the runtime asks Windows
PowerShell 5.1, the Windows twin of the macOS `ls -lde` ACL check. The
executable is `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe` by
absolute path, never found on `PATH`. The argv is constant (`-NoLogo -NoProfile
-NonInteractive -InputFormat None -EncodedCommand <fixed script>`) and contains
no path. The paths for one check travel together in the `SMRT_CUSTODY_PATHS`
environment variable, newline separated, so there is nothing for the PowerShell
parser to interpret; the script uses `-LiteralPath` only (no wildcard
expansion), no `Invoke-Expression`, and a minimal environment (`PATH` is not
passed). It prints one compact ASCII JSON document without paths. The call is
bounded (10 s, 256 KiB, `shell: false`, hidden window). **Any failure is a
refusal**: PowerShell missing, blocked by AppLocker/WDAC/Constrained Language
Mode, a timeout, a non-zero exit, oversized or non-ASCII output, non-JSON, a
different number of answers than paths, or a missing user SID. There is no
"unverified" or best-effort mode. The cost is one PowerShell start (roughly a
second, not measured) per check, at most three per startup; the check is
synchronous (it blocks the event loop) because the operator state root is.
SDDL parsing and the access decision are pure TypeScript.

**Threat table.** Each row is closed by named tests in
`src/windows-custody.test.ts` (any platform) and, where a real Windows
behaviour is involved, `src/windows-custody.win32.test.ts` (Windows runner only).

| # | Threat | Closed by | Closing tests |
|---|--------|-----------|---------------|
| WT1 | Another local user reads or replaces the database, secret, markers, leases or state | W6 custodied rule; default root under the user profile | `W6 policy (WT1 other users, WT3 inherited access)` (foreign owner, Everyone, Users, Interactive, Authenticated Users, a domain admin, another local user, NULL/absent DACL, conditional/object/callback/audit ACEs); `refuses an existing root owned by another user before creating anything (WT1)`; `refuses a lease directory planted by another user (WT1, WT2)`; `rejects a database explicitly shared with Users` |
| WT2 | A junction, symlink or mount point planted in a shared parent at a missing component | W3, W4, post-create W6 | `refuses a symbolic link or junction at an ancestor and at the leaf (WT2)`; `refuses a reparse point that lstat cannot see as a link (WT2, WT7)`; `refuses a directory planted by another user at a missing component, and leaves it alone (WT2)`; real: `refuses a junction at an ancestor and at the root (WT2)` |
| WT3 | A root created under a parent whose inheritable ACL grants others access (`C:\`, `D:\`, or a profile that inherits a third-party group) | the new root is locked (inheritance off, three-principal DACL; smrt#4843), then re-inspected under the custodied rule, with rollback; an existing one is refused by name | `removes a root created under C:\ whose inherited ACL admits other users`; `never removes a directory it did not create`; `a created directory is locked (smrt#4843)` and `a pre-existing directory that fails the rule is refused by name` (`src/windows-acl-lock.test.ts`); `holds a directory it created to the custodied rule even above the root`; `creates a file and removes it again when its inherited ACL is wrong`; `refuses a lease beside a root whose parent would expose it (WT3)`; `refuses a state base whose inherited ACL admits other users (WT3)`; real: `refuses a directory under C:\ ...` |
| WT4 | Hard-link games on the database, secret, markers or lease | `nlink === 1` and handle identity (W5) | `refuses a file with a second hard link (WT4, W5)`; `refuses a handle that is not the file lstat saw, even when the ids round to one number (W5)`; `rejects a database with a second hard link`; `refuses a state marker with a second hard link`; `refuses a path that was swapped while its ACL was being read (TOCTOU)` |
| WT5 | 8.3 aliases, case variants, alternate data streams, trailing dot or space, device names, `\\?\`, UNC, WSL | W1 and W4 | `W1 lexical rule (WT5: aliases, devices, streams)` (every form listed); `appId against Windows device names (WT5)`; `refuses a path that resolves through an 8.3 short name (WT7)`; `refuses a case variant of an existing directory (WT5, D6)`; `refuses to lease through a case variant of an existing parent (D6)`; real: `refuses an 8.3 short-name spelling of a long directory (WT5)` |
| WT6 | Roaming profile or folder redirection | W2: `LOCALAPPDATA` only | `data root base (WT6: roaming profile)` (missing, empty, APPDATA only, relative, share, device path); `puts the state beside the data under LOCALAPPDATA, never the home directory` |
| WT7 | OneDrive or cloud folder, network share, mapped or `subst` drive, FAT/exFAT/ReFS/removable volume | W3 attributes, W4, volume check | `refuses a reparse point ...`; `refuses a path that resolves through a subst drive / a mapped network drive (WT7)`; `refuses a root on FAT, exFAT, ReFS, network, removable or RAM volumes (WT7, D7)`; real: `refuses a subst drive (WT7)` |
| WT8 | Inspector unavailable, blocked or returning garbage | fail closed | `inspector failures (WT8)` (missing PowerShell, timeout, non-zero exit, buffer overflow, oversized, non-JSON, empty, count mismatch, missing/invalid user, non-ASCII, wrong shape, no `SystemRoot`); `creates nothing when the inspector is unavailable`; `refuses an inspector that answers for a different number of paths` |
| WT9 | Command injection through a path into the inspector | constant argv, paths in the environment, `-LiteralPath`, ASCII output | `inspector invocation (WT9: no injection through the path)` (identical argv across calls and no path in it, hostile paths verbatim in the environment, absolute executable, `shell: false`, bounded, allow-listed environment without `PATH`, encoded script equals the reviewed script, no dynamic evaluation); real: `inspects a path full of shell and wildcard characters literally (WT9)` |
| L1 | Two processes sharing a data root derive different leases (case or alias spelling) | lease keyed by the case-folded realpath identity | `derives one lease for every spelling of a data root`; `shares one lock identity across spellings and aliases of one directory` |
| L2 | A Windows process also takes a legacy `/tmp` lease | none exists on Windows | `takes exactly one beside-data lease, never a legacy /tmp lease` |
| S1 | Case variants of one data directory get two state roots and so two writer leases | state-root identity hashes the case-folded root on Windows | `gives case variants of one data directory one state root (one lock domain)` |
| S2 | The state root silently skips its owner checks when no identity is known | the check now throws on every platform | `throws instead of skipping the owner checks when no uid is known` |
| G1 | A half-built root left behind when acquisition fails midway on Windows | the marker pair and every directory created by the attempt are rolled back; the SDK removes a database leaf it created when its second custody pass fails | `rolls back the markers and directories when the database custody check fails` |

Out of scope, as on POSIX: hostile code already running as the same user, and
Administrators or SYSTEM (trusted like uid 0). Repairing the ACL of an existing directory,
encrypting the database at rest, network shares, and Linux-in-WSL data roots on
DrvFs/9p (POSIX uid and mode there are synthesized) are not handled here.

**Not verified on Windows.** Everything above was written and tested without a
Windows machine: the in-memory machine proves the policy and the control flow,
not the operating system. **Every Windows claim in this package stays
unverified until one green run of the `windows-latest` job
(`app-runtime-windows.yml`) is attached to the pull request or recorded on
smrt#4837.** The job is advisory, not a required check; its path filter covers
`packages/app-runtime/**`, `packages/cli/src/app/**` and the workflow itself.

*Known unverified risk: the RID-500 `LA` alias.* The `LA` handling above rests
on how SDDL renders that account, which was not observed on a real machine. If
the runner's `runneradmin` is the built-in RID-500 Administrator and Windows
renders it in some other form than a bare `LA` (for example a full SID that
differs from the `whoami` SID, or a domain-qualified alias), every custodied
path is refused with `access is granted to <trustee>` or `owner is not a
trusted principal (<trustee>)`, the custody tests fail, and the first real run
prints the true descriptors to correct the rule. The failure mode is a refusal
(fail closed), never an acceptance.

Also unverified until the real-Windows tests have run: that `icacls.exe` with
the argv above produces a descriptor the inspector accepts (expected
`D:P(A;OICI;FA;;;<user>)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`), on a stock profile and
on one whose `AppData\Local` inherits a third-party group; how
libuv reports non-symlink reparse tags and `nlink`; `realpath.native` on 8.3,
`subst` and mapped drives; `fs.open` on a directory; the default DACLs of `C:\`,
`C:\Users`, a secondary volume root and `%LOCALAPPDATA%` (the SDDL fixtures
are from memory, and the first real run prints the true ones); the owner of
objects created on the GitHub Windows runner (Administrators versus the user);
PowerShell 5.1 start-up cost, whether it starts with the minimal environment,
and which calls survive Constrained Language Mode; whether `-InputFormat None`
is accepted; and whether the monorepo installs and Vitest runs on
`windows-latest`.

**Decisions assumed, pending owner confirmation** (each is reversible):

- *D1* The custody functions were extracted from `index.ts` into
  `src/local-custody.ts` first, as a no-behaviour-change commit.
- *D4* The PowerShell cost is accepted: fixed argv, paths in the environment,
  fail closed, no "unverified" opt-out.
- *D7* ReFS, and any volume without ACL support, is refused.
- *D8* Windows database acquisition was refused with a named error until
  `@happyvertical/sql` accepted a caller-supplied Windows verifier (sdk#1498,
  0.111.8); it now runs through `windowsCustody.verify` with the rule unchanged.
  Unverified on a real Windows machine until one green `windows-latest` run.
- *D9* The `app-runtime-windows` workflow is added but is not a required check.
- *D10* The trusted-account set is exactly the current user, `SYSTEM` and
  `BUILTIN\Administrators` (plus `TrustedInstaller` for ancestors). A corporate
  image that adds domain-admin or backup-operator ACEs to `%LOCALAPPDATA%` fails
  closed.
- Following the design's recommendations: the SDK takes a caller-supplied
  verifier rather than owning the inspector (D2); there is no best-effort mode
  (D3); canonical comparison is ordinal except for the drive letter (D6).
- Known and not fixed here: on case-insensitive macOS volumes the state-root
  identity still hashes the path as spelled, so two spellings of one data
  directory get two state roots. Folding it would rename every existing macOS
  state root, which is a cross-process contract, so it needs its own change.

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
- **Account switch** (`vault-restart.ts`): `switchVaultAccount` is the only
  way a location stops following one vault account and starts another, after
  a restart (see
  [Restarting when the recovery secret is lost](#restarting-when-the-recovery-secret-is-lost)).

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

### Local MCP tokens

`store.isOwnerSession({ userId, tenantId })` is a read-only check for the exact
sole active local owner. It reuses the desktop credential owner's canonical
identity, membership and permission check; it never issues a session or token.
Use it before exposing installation-wide local credential settings. A tenant
owner role alone does not identify the installation owner; ambiguous ownership
fails closed. Legacy custom stores may omit this capability.
Pass that same actor as `issue(input, ownerSession)` to recheck the binding at
issuance and avoid minting for a different owner if ownership changes meanwhile.

`openLocalMcpTokenStore()` (and `smrt app token`) issue owner-bound, scoped
bearer tokens; only a domain-separated HMAC keyed by the installation secret is
stored. Credentials renew themselves instead of expiring on a short clock:

- **Renewable by default.** A token issued without `expiresInSeconds` has a
  30-day window. Each successful `verify()` slides the expiry to now + 30 days,
  written at most once an hour per token (`lastUsedAt` shows the last slide), so
  verification stays cheap. A token unused for the whole window lapses. Sliding
  never revives an expired or revoked token and never shortens an expiry.
- **Fixed on request.** `expiresInSeconds` (60 s to 365 d) makes a
  fixed-lifetime token that never slides. `list()` reports `renewable`.
- **One token per holder.** `issue({ holder })` (a short printable id) rotates:
  the holder's previous token is revoked in the same transaction that stores the
  new one, so exactly one is valid and a failed rotation keeps the old one.
  The old value cannot be returned (only its HMAC exists); the caller receives
  the new one. A partial unique index backs this up. Tokens without a holder
  behave as before.
- **Revoke with the holder.** `revokeHolder(holder)` (`'revoked'` | `'none'`,
  idempotent; `smrt app token revoke-holder <holder>`) is for whatever removes
  a device or client; this package has no local device-removal path to call it
  from.
- **Reseeding.** The hash key derives from the installation seed, so
  `reseedInstallation` invalidates every token (and revokes the active ones).
- **Upgrade.** Tables from earlier releases gain the `holder`, `sliding` and
  `last_used_at` columns on open; their rows have no holder and stay fixed.

```text
smrt app token --scopes notes.read --holder laptop   # renewable, rotates laptop
smrt app token --scopes notes.read --expires 7d      # fixed lifetime
smrt app token list | revoke <id> | revoke-holder <holder>
```

### Secrets master key

`smrt-secrets` seals every stored secret (an inference provider key, for
one) under an application master key, which a desktop or other local app has
no environment to carry. The local runtime creates it instead, on first use,
and keeps it in the vault key store; the user never sees or types it.

```ts
// Local profile: the runtime owns the key. Elsewhere it returns null and
// SMRT_SECRET_MASTER_KEY is the only source.
const secrets = await SecretService.create({
  db: await runtime.database(),
  masterKeyProvider: () => runtime.secretMasterKey(),
});
```

- `runtime.secretMasterKey()` (SvelteKit runtime) and
  `LocalApplicationRuntime.secretMasterKey()` return 64 hex characters for
  `SecretService.create({ masterKeyProvider })` and nothing else. Never log
  it, return it from a route, or keep it.
- **Once, then reused.** The first call creates 32 random bytes as the vault
  key store item `smrt-secrets.master-key`, under the data root's
  initialization lock so concurrent processes agree. Every later call, and
  every restart, loads the same one.
- **Env wins.** `SecretService` asks the provider only when
  `SMRT_SECRET_MASTER_KEY` is unset. On a deployed profile the method returns
  `null`; the runtime never generates a key outside the local profile.
- **Custody seam.** Selection, first match wins: an injected `vaultKeyStore`
  (on `initializeLocalApplicationRuntime` or `createSmrtSvelteKitRuntime`);
  else, when the desktop wrapper started the process
  (`SMRT_DESKTOP_KEYCHAIN=1`), the OS-keychain-wrapped store
  (`createKeychainVaultKeyStore`, below), with no application code; else
  `createFileVaultKeyStore` on an owner-only `.smrt-keys-<data directory
  name>` directory beside the data root. Every option keeps the key outside
  the data root.
- **Backups.** The data root holds the database and the sealed secrets, never
  the master key, so a plain file backup of it carries ciphertext without its
  key; restoring it on another machine does not decrypt secrets, and the
  user re-enters them. Under the desktop wrapper the key item is itself
  sealed by a key in the OS keychain, so even a backup that also copies the
  key directory is not enough without the user's OS login.
- **`SecretService` stays explicit.** `smrt-secrets` does not depend on the
  runtime (package DAG), so `SecretService.create` does not look for a local
  key by itself: pass `masterKeyProvider: () => runtime.secretMasterKey()`.
- **Fails closed.** A store that cannot be read, or an item that is not 32
  bytes, rejects with `LocalRuntimeError` code `secret_master_key_unavailable`,
  whose message names no key material or path. A malformed item is never
  replaced: a new key would orphan every secret the old one sealed. Losing
  the item loses the stored secrets (a key re-entered afterwards is stored
  under a new master key).

### Origin file

When the desktop supervisor starts the app it sets `ORIGIN=http://127.0.0.1:<port>`.
If `ORIGIN` is exactly that form, `createSmrtSvelteKitRuntime()` writes
`origin.json` (`{ version: 1, origin, pid, startedAt }`, mode 0600, nothing
secret) to the application state root once local startup succeeds, and removes
it when the process exits or receives SIGTERM or SIGINT (best effort, so a crash
leaves a stale file). It lives in the state root, not the data root: it is
per location and a backup or copy of the data root does not carry it. Any other
`ORIGIN` writes nothing. `readOriginFile(stateRoot)` returns the record or
`null` (absent, unreadable, not owner-private, malformed, not an exact loopback
origin, or its `pid` is gone) and never throws; a reader must still probe the
origin. `writeOriginFile`, `removeOriginFile` and `parseLoopbackOrigin` are
exported from the root. The assistant-plugin launcher
(`@happyvertical/smrt-desktop/launcher`) is the reader.

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
  // Optional, idempotent, runs on every start after the framework schema:
  // `(db, { firstRun, paths, migrateSchemas })`. See "First start".
  prepareDatabase: runApplicationMigrations,
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
// src/routes/api/_runtime/owner-link/+server.ts (desktop apps)
export const GET = createOwnerLinkHandler(runtime);
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

#### Desktop owner link

A desktop app opens its window on a fixed route, `OWNER_LINK_ROUTE`
(`/api/_runtime/owner-link`, the sidecar manifest's `ownerClaimRoute`), instead
of the bare origin. `createOwnerLinkHandler(runtime)` answers a `GET` there with
a `302` to `/setup?token=<one-time token>` while the local owner is unclaimed
and to `/` otherwise (claimed, deployed profile, nothing issuable). It is the
existing machinery, not a second sign-in: the token is the invitation this
process's startup issued (the same one `onBootstrapInvitation` receives), or,
when that plaintext is gone because the app restarted before the claim or the
invitation expired, a rotated one (`rotateBootstrapInvitation()`, as
`smrt app recover`). The owner then claims through the usual `/setup` page and
`claimOwner()`, which stays the single-use gate; a spent link fails there.

The route requires a per-launch secret. The desktop wrapper draws 32 random
bytes from the OS on every sidecar start, passes them only in the sidecar's
environment as `SMRT_DESKTOP_OWNER_LINK_SECRET` (a name a sidecar manifest
cannot set) and opens its window on `OWNER_LINK_ROUTE?launch=<secret>`. The
handler compares the `launch` query value with the variable in constant time
(both sides are hashed with SHA-256 first, so lengths do not leak) and answers
`403` with an empty body for a missing, empty or wrong value. With no secret
configured, which is the case whenever the app is not running under the
wrapper, it answers `403` to every request, so the route is never open by
default. Pass `createOwnerLinkHandler(runtime, { launchSecret })` to supply the
secret explicitly (tests). Another process or OS user on the machine can reach
the loopback port but does not hold the secret, so it cannot fetch the link and
claim ownership first.

On top of the secret the route still answers only a request from this device
addressed to the app's own origin: a loopback peer address, a loopback `Host`
equal to the URL's host, no foreign `Origin`, no `Sec-Fetch-Site: cross-site` or
`same-site`; anything else is a `403` with an empty body. Responses have an
empty body, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; the
token is only in `Location`, which the desktop wrapper's webview follows and the
wrapper never reads or logs. The secret and the query string are never logged
or echoed, and the runtime writes no access log. `runtime.ownerSetupLocation()`
is the underlying method; never log or serialize its result.

##### `autoClaim`: no form, never locked out

`createOwnerLinkHandler(runtime, { autoClaim: true })` (opt-in; default off, so
other consumers keep the `/setup` redirect above) uses the launch secret as the
proof that the local person is at the keyboard and signs them in directly. After
every check above passes (secret, loopback peer, own-origin Host and `Origin`,
local profile), `runtime.signInLocalOwner()` runs serialized per process:

- no owner yet: the owner is created through the same `claimOwner()` transaction
  (Person, User, Tenant, owner Role and Membership, Session) with a fresh
  invitation that never leaves the call, then the `smrt app` hand-off files are
  removed;
- an owner exists and the request carries no session of that owner (the cookie
  was lost): a new session is issued for the sole active owner;
- the request already carries the owner's session: nothing is issued.

The handler sets the session cookie with the `/setup` attributes and answers
`302` to `/`. Anything but exactly one active owner (none after a spent
invitation, several memberships with the owner role, an inactive user) fails
closed with `owner_unavailable`: no session is issued and the handler redirects
to `/`, which shows the signed-out page. Outside the `local` profile it issues
nothing. Concurrent first requests create one owner. The terminal flow
(`smrt app setup`/`open`/`recover`, `/setup?token=`) is unchanged.

The auto-created owner has no email: `User.email` is `''` (its unique
`emailKey` stays `NULL`, so nothing collides or reserves an address) and the
Person profile has no email. The name is `autoClaim`'s `ownerName` option,
else the OS account's user name, else `Owner`. Neither is a secret. The owner
adds a real name or email later; the shell does not yet have an Account editor
for that.

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
- **Replay and clock rollback.** `<filePath>.watermark` keeps the newest
  accepted `issuedAt` and highest observed clock time (`observedAt`), including
  observations after expiry and authenticated expired offers. Both `install()` and `status()` compare against
  it; rolling the clock back before `observedAt` yields the Local tier
  (`expired`), even during grace, until the clock catches up. Expired status
  retains the authenticated `issuedAt`, `expiresAt`, and `graceEndsAt`.
  Existing version-1 watermarks without `observedAt` acquire it on the next
  authenticated read. The standalone `verifyDeviceEntitlementSnapshot()` checks
  signature, identity and expiry only; use the cache for replay protection.
- **Concurrency and persistence.** All cooperating processes must share the
  private cache destination. `<filePath>.lock/operation.lock` uses the runtime's
  existing operation lock and stale-owner recovery. Calls on one cache instance
  queue; contention with another instance/process fails closed (`unreadable`
  status or `storage_failed` install), so retry after the other operation ends.
  The watermark is atomically replaced before the snapshot: a partial failure
  may leave an older snapshot denied, and retrying the newer install repairs it.
  A canonical signed-envelope digest reserves same-timestamp identity before
  replacement, so a conflicting offer cannot take over after a partial failure.
  Do not run older binaries that omit this lock against the same cache.
  A user who deletes or corrupts the watermark (or both files) can still replay
  a snapshot that has not expired; keep issued lifetimes short enough that this
  is acceptable. These files do not protect against their owner's rewriting
  the private directory. A snapshot carries at most 64 keys of 128 characters.
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
items, with atomic replacement. Both stores below come from
`@happyvertical/smrt-app-runtime/vault-key-store`.

**Keychain-wrapped store** (`createKeychainVaultKeyStore`; the local runtime
selects it by itself when the desktop wrapper sets `SMRT_DESKTOP_KEYCHAIN=1`).
A random 32-byte key-encryption key lives in the OS keychain under the
service `smrt-vault.<product id>`: macOS Keychain (`security`), Windows
Credential Manager (PowerShell and `advapi32`), or Linux Secret Service
(`secret-tool`). Items are sealed with AES-256-GCM (into a `.smrt-sealed-keys-<data directory name>` directory beside the data root), with a random nonce and
the product id and item name authenticated, so an item cannot be moved to
another name or product, and stored through the owner-only atomic file
store, so Credential Manager's blob limit never applies. Secrets reach the OS
tools only on stdin or stdout, never argv, environment, logs or URLs, and
errors are fixed text. `custody()` reports `os-keychain` or `file-fallback`.

- No usable keychain (tool missing, headless Linux without a Secret Service
  on the session bus, unsupported OS): it falls back to the plain file store
  in the same directory the runtime would otherwise use, outside the state
  root, and `custody()` says so with the reason. Existing file-store items
  keep the file store, so switching never orphans them.
- It never falls back and never replaces a key when sealed items exist but
  the key is missing, malformed or unreadable: that fails closed, because a
  new key would orphan them. Losing the keychain entry loses the items.
- The first creation of the key is not cross-process atomic; the runtime
  serializes it under the data root's initialization lock and the desktop
  wrapper is single-instance.

**File store** (`createFileVaultKeyStore(dir)`), for headless and development
installs:

- The directory must be absolute. It is created with mode 0700 and must be a
  real directory owned by the current user.
- Items are mode 0600 files replaced by atomic rename.
- On Windows, POSIX modes are synthetic and there is no uid, so the file
  store performs no custody check. Place the directory under the user's
  profile, and prefer the keychain-wrapped store there.
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
  - `rotation_required` while a local revocation is pending (see `rotation`
    on `status()`)
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
authority. The remedy today is a new account (see
[Restarting when the recovery secret is lost](#restarting-when-the-recovery-secret-is-lost)).
Authority re-keying is tracked in #4807.

`revokeDevice(deviceId, { recoverySecret })` takes the recovery secret as
proof, #4818. It opens the authority record the adopted head signs, changes
nothing else, and only then records a local pending revocation. A wrong,
missing or superseded secret fails with `recovery_rejected` and records
nothing, so revoking and rotating succeed or fail together: a revocation never
exists on a device that cannot rotate. There is no cancel path, so a stolen
device cannot cancel its own revocation, and with only its own device secret
it cannot revoke a peer to stop the others sealing. Who may revoke is
unchanged: whoever holds the recovery secret.

**Caller contract.** Revocation is two calls on one device:

1. `revokeDevice(deviceId, { recoverySecret })`. From here this device refuses
   to seal (`rotation_required`, so its backups stop) and refuses to enroll.
   Other devices keep sealing, because unsigned revocations are never
   broadcast: a stolen device could use them to lock the others out.
2. `rotate({ recoverySecret })`. Publish the returned head, authority record,
   recovery record and grants. Sealing resumes on this device and the
   revocation reaches the peers with the rotation.

Run both in one user flow and ask for the secret once. Between the two calls
backups on this device are paused, so say so in your UI instead of letting
each seal fail.

`status().rotation` says why sealing is stopped and whether the rotation is
known to be possible. It is null while nothing requires one.

| `rotation` | Meaning | Product action |
| --- | --- | --- |
| `null` | No rotation needed | none |
| `{ reasons: ['revocation'], secretProven: true }` | Rotation required and possible: the secret was proven when the revocation was recorded | finish with `rotate` |
| `{ reasons: ['conflict'], secretProven: false }` | Fork evidence arrived from the relay; the secret has not been proven | ask for the secret, then `rotate` merges |
| `{ reasons: [...], secretProven: false }` | Any state that includes a conflict, or a revocation recorded by a build that predates the proof | ask for the secret; if it is lost the way out is a [restart](#restarting-when-the-recovery-secret-is-lost) |

`reasons` lists `revocation` and `conflict`. `rotationRequired` and `conflict`
remain as before.

**The fork differs from a revocation by design.** A revocation is the user's
own act, so it can be refused without the proof. Fork evidence arrives from
the relay unasked, and recording it is what stops this device sealing into a
diverged account; refusing evidence for want of the secret would hide the
fork. So the conflict is always recorded, and the signal is how a product
tells that its merge has not been proven possible. `rotate` fails with
`recovery_rejected` without the secret, and sealing stays stopped until a
head containing the evidence is adopted. A family with a conflict and no
secret has no merge: the way out is a
[restart](#restarting-when-the-recovery-secret-is-lost).

A pending revocation clears only when an adopted head revokes that exact
device ID and public key. If another device rotates without having seen the
local revocation, its new key still reaches the device you meant to revoke.
Rotate from the device that revoked.

A revoked device gets no new generation. Peers reject its grants once they
know of the revocation. It keeps any generation it had already opened.
`recoveryRecord({ generation, keyId })` returns a held recovery record for
publication.

### Restarting when the recovery secret is lost

Enrolling a device, rotating and setting a new recovery secret all need the
current secret, because it unwraps the authority that signs heads. A family
that loses it while its devices still work keeps reading, sealing and backing
up, but the account is frozen: no device can be added, and if every device is
later lost the backups open for nobody. The way out is a new vault account
started from a working device (#4817). It costs the family their backup
history under the old account and every other device a re-enrolment, and it
needs no knowledge of the old secret. HappyVertical keeps no escrow copy, so
there is no shorter route, and device-approved enrolment is a separate
authority-rule decision that this does not make.

**Detect it before the family is stuck.** `checkRecoverySecret(secret)`
returns `{ authority, currentKey }` and changes nothing: `authority` is
whether the secret opens the authority record the adopted head signs, and
`currentKey` whether it opens the current key's recovery record (`null` when
this device does not hold that record). A wrong secret is `false`, not an
error. Ask the family to type the secret in periodically, for example every
few months and after any rotation, run the check, and show the result. A
`false` while the devices still work is the moment to offer the restart.

**The restart**, in order. The account layer is the hosted service that
provisions accounts and holds the relay admin token. It must re-authenticate
the human owner before step 1. This is a **hard requirement**, not a
suggestion: the local calls in steps 2 and 3 cannot tell the owner from
someone holding the unlocked device, so the account layer is the only gate on
a takeover of the backup line. A product that offers the restart without it
is not safe to ship. Before
starting, ask every device to publish: after step 1 the old account takes no
writes, and there is no merge, so what a device has not published is not in
the new account.

1. Account layer: provision the new vault account (a fresh account ID with
   the `backup.vault` entitlement), register the working device's relay
   signing key in it, then replace the old account (relay admin
   `PUT .../superseded-by`). From then on the old account takes no writes and
   offers nothing to restore-latest, so a device still following it stops
   publishing into a dead line and says why (`account_superseded`). The relay
   admin `DELETE` of the same path undoes this, but only for a restart that
   never reached the working device: once step 2 has run, there is no API
   that undoes `restartAccount` locally. That device is on the new account
   and finishes the restart (steps 2 to 5). A backup on it that still targets
   the old account is refused (`account_mismatch`) and nothing is sealed, so
   even a reverted supersession cannot move the old account's data line.
2. Working device: `restartAccount({ accountId, deviceId, recoverySecret,
   confirmRestart: true })`, where `recoverySecret` is a **new** secret the
   user writes down now. It parks the old account (`previousAccount()`) and
   creates the new one with its own device secret, authority key and first
   data key. Nothing from the old account is carried across. Publish the
   returned head, authority record and recovery record to the new account.
   After a crash, call it again with the same input.
3. Working device, holding the operation lock:
   `switchVaultAccount({ stateRoot, lifecycle, from, to, lease })` from
   `@happyvertical/smrt-app-runtime`. It moves the location's vault position
   to the new account at sequence zero with local writes pending, so the next
   backup is a full baseline. It refuses unless the lifecycle shows this
   exact restart, the relay reports the new account empty, and the location
   is active. It is the only code that resets the downgrade floor. Start the
   key provider's snapshot sequence counter again at 1 for the new account
   (the relay refuses a first sequence far above an empty account's mark),
   and take a fresh backup through the normal path.
4. Every other device: `leaveAccount({ confirmLeave: true })`, then the
   normal exchange against the new account: `createEnrollmentRequest`, the
   working device's `enrollDevice` with the **new** secret, then
   `acceptEnrollment`. A wiped device uses `enrollFromRecovery` with the new
   secret. An installation that already follows the old account moves with
   `switchVaultAccount({ ..., role: 'follower', fromLease })`, which accepts an
   account that already holds snapshots but only once the relay reports the
   old account as replaced (`fromLease`, signed as the device's old-account
   key; keep the old account's devices registered until every device has
   followed). Unpublished local writes stay marked, so restore-latest still
   asks for `--discard-local`; its next step is restore-latest, never a
   backup over the new account. A fresh device is
   simply pointed at the new account by the host, and restore-latest then
   restores the new account's snapshot.
5. When the new account is backed up and the other devices have joined:
   `discardPreviousAccount()` deletes the parked account's wrapped keys and
   records. It refuses (`restart_incomplete`) while the device holds no
   current account, and it never deletes a key the current account uses.

**Deploying.** Run the relay migration job (`migrateVaultRelayV1`, which now
also creates `vault_relay_supersessions`) before deploying a relay that
includes supersession. Until it has run, the relay's `/readyz` reports
`schema_missing`.

The relay never tells a client which account to follow: `account_superseded`
is a stop signal, and the host's trusted configuration decides the account.
The parked keys are a local undo and a hold for a manual rescue, and the old
account's snapshots stay on the relay, readable by explicit sequence, until
the operator deletes them.

**One call for steps 2 and 3.** `restartVault` from
`@happyvertical/smrt-cli/app` (#4838) runs the working device's part: it reads
the three stores a restart touches (the key lifecycle, `vault-sync.json`, the
host's followed-account config), runs only the missing steps in this order,
and returns a report. Order: `restartAccount`, the host's `publish`,
`switchVaultAccount`, the host's `followAccount`, then the first backup. The
host config flips after the sync position on purpose: until it does, a backup
still targets the old account while the keys are on the new one, and it is
refused (`account_mismatch`) before anything is sealed. The report's `state`
is `complete` (all steps done, or found done: calling again is a no-op),
`resumed` (an earlier call stopped part way and this one finished it),
`mismatch` (a step failed and the stores disagree: call again; or, with
`repairable: false`, a store follows an account that is neither the old nor
the new one, nothing was changed and a person must look) or `backup_failed`.
`inspectVaultRestart` reads the same state without changing anything, for a
host that checks at startup. The new recovery secret is only needed while
something is outstanding, and no report carries it or any key.

**Back up immediately after every rotation** (#4834, strict rule kept):
snapshots sealed under the older generation are refused on restore until an
enrolled device publishes a new one, so the window between a key change and
the first backup is the window in which losing the last device loses the
history. The restart's last step is that backup, and a rotation goes through
`rotateVaultKeys` (same module), which publishes and backs up at once. Both
report `backupAfterRotation: 'done' | 'failed' | 'skipped'`; a failed backup
is the distinct state `backup_failed`, never a quiet success, and the host
must keep retrying until it clears. The backup counts only once
`vault-sync.json` records the published sequence.

**Rescuing the old account by hand.** While the account is parked,
`openPreviousReadingKey({ accountId, generation, keyId })` opens one of its
data keys as a reading key bound to the old account id (`purpose: 'read'`,
`key` not enumerable so it does not survive JSON or a spread). It writes
nothing and cannot seal. It refuses with `no_previous_account` when nothing is
parked or after `discardPreviousAccount()`, `account_mismatch` for any other
account id (including the current one) and `key_missing` for a key the parked
account did not hold. In the CLI package `createPreviousAccountSnapshotKeys`
wraps it as the opening-key side of the snapshot seam, for `decryptSnapshot`
on a snapshot fetched by hand from the old account. There is no `smrt app`
subcommand for it yet.

What a restart cannot do: it does not recover the old account's data from the
relay (the data lives on the working device and is backed up afresh), it does
not revoke a leaked old secret on a relay that still serves old records
(#4807), and it does not help when no device still works.

### Threat model notes

- Whoever holds the recovery secret is the account. Typing it on a device
  gives that device's malware authority.
- A stolen device secret alone can only replay authentic heads and keys, or
  send grants that are rejected.
- Concurrent changes by two holders of the recovery secret fork the account.
  Sealing stops until a merge rotation.
- A stolen device cannot record a revocation, so it can neither lock peers out
  of sealing nor strand its own owner: recording needs the recovery secret
  (#4818), and a revocation cannot be cancelled.

### Product rules

Losing every enrolled device and the recovery code means losing the data.
HappyVertical holds no escrow copy of any key and cannot recover it.

Losing only the recovery code freezes the account without losing data. Prompt
the family to confirm the code periodically with `checkRecoverySecret`, and
tell them up front what a restart costs: a new code, a fresh backup history,
and every other device re-enrolled.

## Durable owner tool approvals

`OwnerApprovalAuthority` is a host boundary for tool-call holds, backed by an
`OwnerApprovalStore`. `createSqliteOwnerApprovalStore(db)` is the default adapter:
it **reuses smrt-approvals `ApprovalService`** for decisions, expiry, the human
actor ledger, revision binding and single-use consumption. The runtime-owned
`_smrt_owner_tool_holds` table stores only the immutable tool/principal/arguments
recovery envelope and execution result. Include smrt-approvals in normal schema
migrations before serving; the adapter never creates application model schema.

Construct the authority with a mandatory live owner check (normally
`actor => isApprovalOwner(db, actor)`). Request from trusted host code, list/decide
with the authenticated human actor, consume before effects, and complete with the
result. Never offer authority methods as model tools or accept a request body as
the saved principal. Default expiry is 15 minutes (configurable 1 minute–24 hours).
A consumed call is never retried automatically: after a process crash during an
external effect its state is `executing`, requiring operator reconciliation.
Pending holds and approved but unconsumed decisions survive a restart. The generic
approval service supplies the append-only decision audit; the host supplies effect
and transcript authoring. See [the contract](agents/owner-approvals.md).

### Test process storage boundary

`SMRT_FORBIDDEN_STATE_BASES` is an opt-in JSON array of state/data base paths.
State-root resolution and default local-data custody refuse matching bases using
the platform's path identity rules, before creating storage. With the variable
unset, normal path derivation is unchanged. Explicit path-derivation environment
options do not override this inherited process boundary. Test runners use
`@happyvertical/smrt-vitest/test-home` to install temporary homes and pass this
variable to children, including production-mode launchers and sidecars. See
[the test-home contract](../vitest/agents/test-home.md).
