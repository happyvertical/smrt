# @happyvertical/smrt-desktop

Versioned JSON contracts for a runtime bundled with an s-m-r-t desktop app.
The runtime bundler writes the sidecar manifest and the desktop supervisor
consumes it before launching the packaged executable. The installed-product
contracts below let other programs on the same machine (an assistant launcher,
a plugin) find and verify that installed app. The package has no runtime
dependencies and uses only Node built-ins.

## Node 26 and adapter-node example

This [manifest](examples/node26-sidecar.json) describes a stock Node 26 sidecar
and a SvelteKit adapter-node build, in the layout `smrt desktop bundle` writes:
the sidecar is product-scoped (`<productId>-node`, never a bare `node`), the
app sits under `app/` in the resource directory, and `env` empties the
`NODE_OPTIONS` and `NODE_PATH` the shell would otherwise inherit from the
parent process. Mount the app-runtime health handler at `/api/_runtime/health`
and use the local runtime profile.

```json
{
  "version": 1,
  "executable": "smrt-notes-node",
  "args": ["app/build/index.js"],
  "healthRoute": "/api/_runtime/health",
  "dataDirectory": "runtime",
  "env": { "NODE_ENV": "production", "NODE_OPTIONS": "", "NODE_PATH": "" }
}
```

```ts
import { readFile } from 'node:fs/promises';
import { parseSidecarManifest } from '@happyvertical/smrt-desktop';

const sidecar = parseSidecarManifest(
  await readFile('node26-sidecar.json', 'utf8'),
);
```

## Version 1 fields

- `version` is the number `1`. The five fields `version`, `executable`,
  `args`, `healthRoute` and `dataDirectory` are required; `env` and
  `ownerClaimRoute` are optional. Unknown fields and versions are errors. A
  future incompatible contract requires a new version.
- `executable` is the logical Tauri `externalBin` basename: exactly one
  portable segment with no `/`, such as `smrt-notes-node`. The launcher owns the
  `-<target-triple>` and `.exe` suffixes and resolves the file from the
  packaged `externalBin` mapping. It never searches `PATH`.
- `args` is an ordered array of literal strings. Empty arrays and empty strings
  are valid. NUL and unpaired UTF-16 surrogates are rejected. The supervisor
  passes the array directly as process arguments. The argument strings receive
  no shell expansion, token substitution, or path rewriting. Their
  interpretation belongs to the chosen executable.
- `healthRoute` is a path on the supervisor-selected loopback origin.
  It begins with one slash and can be `/` or have nonempty segments containing
  only ASCII letters, digits, periods, underscores, tildes, and hyphens.
  A trailing slash is allowed. Dot segments, URL origins, network-path
  references, backslashes, percent escapes, queries and fragments are invalid.
  The probe stays on the selected loopback origin and rejects redirects.
- `ownerClaimRoute` (optional) is the path on the supervisor-selected origin
  where the local runtime's owner setup lives. It follows exactly the
  `healthRoute` grammar and loopback rules. The manifest only declares it;
  claim tokens and their handling belong to the supervisor and runtime.
- `dataDirectory` is a portable path relative to Tauri's stable `app_data_dir`
  (the per-app OS data root). The supervisor supplies its resolved absolute
  path to the local runtime as `SMRT_DATA_DIR`. The app-runtime retains
  ownership of directory custody.
- `env` (optional) is a JSON object of string names to string values added to
  the sidecar environment. Names match `[A-Za-z_][A-Za-z0-9_]*`, must be unique
  ignoring case, and must not be reserved. Values may not contain NUL or
  unpaired surrogates. The empty object is valid.

### Directory layering

Three locations are never conflated:

1. Executable lookup: the `executable` basename resolves through Tauri
   `externalBin`, with the target suffix added by the launcher.
2. App root: the packaged app/resource root is the sidecar's working
   directory, so relative `args` such as `app/build/index.js` resolve against it.
3. Data root: `dataDirectory` resolves under `app_data_dir`, outside the app
   root, so app updates never touch runtime data.

### Supervisor-supplied environment

`HOST`, `PORT`, `ORIGIN` and `SMRT_DATA_DIR` are exported as
`RESERVED_ENV_KEYS`. The supervisor sets `HOST=127.0.0.1`, `PORT` to the
selected port, `ORIGIN=http://127.0.0.1:<port>` and `SMRT_DATA_DIR` to the
absolute resolved data directory. A manifest `env` naming any of them, in any
letter case, is rejected at parse time with a value-free diagnostic.
`buildSidecarEnv(manifest, { port, dataDirectory }, baseEnv)` composes the
final environment: it drops reserved names from `baseEnv` (case-insensitively),
layers the manifest `env`, then applies the reserved values last so they always
win. `port` must be an integer from 1 to 65535 and `dataDirectory` a nonempty
absolute path (POSIX, `C:\`, or UNC form, checked lexically); otherwise it
throws a fixed diagnostic. Variables of `baseEnv` with value `undefined` are
omitted.

### Paths and JSON

Portable paths use forward-slash-separated nonempty segments, each starting
with an ASCII letter, digit, underscore or hyphen. Subsequent characters may
also include periods. Trailing periods and Windows device names (`CON`, `PRN`,
`AUX`, `NUL`, `COM0` through `COM9`, and `LPT0` through `LPT9`, including
extension forms) are rejected. The same lexical rules apply on each target.
`executable` is a single such segment; `dataDirectory` may have several.

The parser throws a fixed diagnostic on malformed JSON or invalid fields and
returns a typed snapshot on success; absent optional fields are omitted from it.
Duplicate JSON object keys at any depth, including inside `env` and compared
after unescaping, are rejected because `JSON.parse` would silently keep the
last one. Names such as `__proto__` are plain data and cannot alter prototypes.
The bundler serializes the snapshot to write the artifact, so consumers
receive one occurrence of each field. The manifest is trusted package content.
The bundler and supervisor enforce executable provenance and filesystem
containment, including symlink handling. Argument policies belong to the
packaging tool and runtime being launched.

## Installed-product contracts

Three files and one channel describe an installed desktop product to the rest
of the machine. This package defines the files for the installed product
itself (below), then the supervisor rendezvous (`instance.json` and the
owner-only control channel). The native credential handoff is a separate
contract with its own section.

| Artifact | Written by | Read by | Contains |
| --- | --- | --- | --- |
| `sidecar-manifest.json` | bundler | supervisor, `locateInstallation` | what to run (see above) |
| `smrt-bundle.json` | bundler | `locateInstallation`, launcher, plugin generator | identity and resource-relative layout |
| `installation.json` | desktop shell, at every start | `locateInstallation` | absolute paths the shell runs from |
| `instance.json` | desktop shell, on every phase change | `createFileRendezvous` | the running instance: nonce, control endpoint, state, origin |
| control channel | desktop shell (server) | `createFileRendezvous`, launcher | `status`, `ensure-ready`, and the credential contract's `acquire-credential` (owner-only socket or pipe) |
| `mcp-slot.json` | desktop shell | shell, `acquire-credential` handler | non-secret credential slot metadata (see the credential handoff) |

`smrt-bundle.json` is static trusted package content (same trust class as the
sidecar manifest, sealed by the bundle's code signature). `installation.json`
is a hint written into the private state directory: a consumer never trusts it
alone, it re-reads the bundle manifest from the recorded resource directory and
re-verifies every path (see `locateInstallation`).

All v1 documents share these rules: strict JSON (duplicate keys at any depth
rejected, closed schema, unknown fields rejected), `version: 1` (an
incompatible change is a new integer; an unknown version is rejected as
`unsupported_contract`), frozen parse results, and a fixed, value-free
diagnostic on every failure.

### Errors

Parsers and `locateInstallation` throw `DesktopContractError` with a `code`
from a closed union (`InstallErrorCode` for this contract, `RendezvousErrorCode`
for the rendezvous). The `message` is
fixed text keyed by the code: it never contains a path, origin, pid or secret,
so a caught error is safe to log. When a document field was the cause, `field`
names the schema field (for example `bridge.entry`), never the value.
The older sidecar manifest parser predates this type and still throws plain
`Error`s with its own fixed messages; its behavior is unchanged.

| Code | Meaning |
| --- | --- |
| `not_installed` | no record, or the recorded app is gone: open the app once |
| `identity_mismatch` | product, version, target or platform differ from what was recorded or expected; benign after an update until the app restarts |
| `untrusted_path` | a symlink, foreign owner, group/other-writable path, wrong file kind, or a layout that escapes the install root |
| `unsupported_contract` | a `version` other than 1 |
| `invalid_json`, `duplicate_keys`, `invalid_document`, `invalid_field` | malformed document |
| `sidecar_mismatch` | the bundle manifest and the sidecar manifest disagree on the Node executable |
| `invalid_environment`, `unsupported_platform` | `resolveAppLocalDataDir` could not derive a location |
| `invalid_secret` | `SecretString` was given an unusable value |
| `invalid_control_message`, `control_message_too_large`, `unsupported_op` | a control-channel message violated the protocol (see below) |
| `invalid_endpoint`, `untrusted_endpoint` | a control endpoint is malformed, or its directory failed the trust checks |
| `control_unreachable`, `control_timeout`, `control_aborted`, `control_server_failed` | control-channel transport outcomes |

The credential handoff adds `CredentialErrorCode`; see
[Credential error codes](#credential-error-codes).

### SecretString

`SecretString` wraps a value that must not leak. It redacts through
`toString`, template literals, `JSON.stringify`, `util.inspect`/`console.log`
and `Symbol.toPrimitive`. The value lives in a `#private` field, so the
instance has no own properties: spreading, `Object.assign` and
`structuredClone` yield an empty object. The constructor rejects non-strings,
empty strings, NUL and unpaired surrogates (`invalid_secret`). `equals` is
constant time (both sides are SHA-256 hashed before a `timingSafeEqual`, so
neither contents nor length influence the timing). `reveal()` is the only
accessor and exists for exactly one caller, the final handoff of the value to
the process that needs it. Keep every other use out of the code base and grep
for `reveal(` in review.

### Bundle manifest v1 (`smrt-bundle.json`)

The runtime bundler writes it into the Tauri resource directory next to
`sidecar-manifest.json`; [examples/smrt-bundle.json](examples/smrt-bundle.json)
is the reference. It holds identity and resource-relative paths only; absolute
paths do not exist at bundle time.

```json
{
  "version": 1,
  "productId": "smrt-notes",
  "bundleId": "com.happyvertical.smrt-notes",
  "displayName": "SMRT Notes",
  "productVersion": "1.4.0",
  "channel": "stable",
  "target": "aarch64-apple-darwin",
  "sidecarManifest": "sidecar-manifest.json",
  "node": { "executable": "smrt-notes-node" },
  "bridge": {
    "entry": "bridge/smrt-mcp-bridge.mjs",
    "envPrefix": "SMRT_NOTES",
    "mcpPath": "/api/mcp",
    "serverName": "smrt-notes",
    "serverVersion": "1.4.0"
  }
}
```

- `productId` is a lowercase kebab-case slug (`^[a-z0-9]+(-[a-z0-9]+)*$`, at
  most 64 characters). `bundleId` is the Tauri `identifier` in reverse-DNS form
  (`^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`, at most 255 characters); because it
  becomes a directory name, a leading Windows device name (`aux.example.app`)
  is rejected.
- `displayName` is single-line plain text of 1 to 128 characters: no control,
  line-separator or bidirectional-override characters, no surrounding space.
- `productVersion` is a semantic version, `channel` matches
  `^[a-z][a-z0-9-]{0,31}$`, and `target` is a Rust target triple such as
  `aarch64-apple-darwin`.
- `sidecarManifest` and `bridge.entry` are resource-relative portable paths
  (the same segment rules as `dataDirectory` above). `bridge.entry` is the
  single-file MCP bridge and must end in `.js` or `.mjs`.
- `bridge.envPrefix` matches `^[A-Z][A-Z0-9_]{0,31}$`, `bridge.mcpPath` follows
  the `healthRoute` grammar, and `serverName` (1 to 64 characters, display
  text) and `serverVersion` (semver) are optional.
- `node.executable` is the logical `externalBin` basename of the Node sidecar,
  one portable segment. It must equal the sidecar manifest's `executable`;
  `assertBundleMatchesSidecar(bundle, sidecar)` throws `sidecar_mismatch`
  otherwise. `healthRoute` comes from the sidecar manifest and is not
  duplicated here.

`parseBundleManifest(json)` and `serializeBundleManifest(manifest)` are the
parser and the canonical writer (fixed key order, two-space indent, trailing
newline). The serializer validates first, so a bundler cannot emit a document
the parser would reject. Both are exported from the package root.

**Design finding F5 (for the owner): name the Node sidecar per product.**
Tauri installs `externalBin` sidecars next to the main binary, which for
`.deb` and `.rpm` is `/usr/bin`. A sidecar whose logical name is the bare
`node` would install `/usr/bin/node` and collide with the distribution's own
Node. This was reasoned from Tauri's documented behavior and not verified with
a build. Both examples therefore use the product-scoped `smrt-notes-node`, the
runtime bundler always names the sidecar `<productId>-node`, and the sidecar
manifest of a product must use the same name as its bundle manifest. The
parser does not forbid `node`; the product-scoped name is a convention the
bundler enforces.

### Installation record v1 (`installation.json`)

The desktop shell writes it on every start, after it holds the single-instance
lock and before it spawns the sidecar, into the private state directory (next
section). Because it is rewritten on each start it heals itself when the app is
moved or updated. [examples/installation.json](examples/installation.json) is
the reference; the Rust shell's tests use the same fixture.

| Field | Meaning |
| --- | --- |
| `productId`, `bundleId`, `productVersion`, `target` | identity, copied from the bundle manifest |
| `platform` | `darwin`, `win32` or `linux`; selects the path rules below |
| `installRoot` | `X.app`, the install directory, or `/usr` for `.deb`/`.rpm` |
| `executableDir` | directory of the shell binary and the `externalBin` sidecars |
| `resourceDir` | Tauri resource directory (holds `smrt-bundle.json`) |
| `shellExecutable` | the shell binary, used to start the app without a window |
| `recordedAt` | ISO-8601 UTC, informational only |

The four paths must be normalized absolute paths of the record's platform:
`/a/b` on macOS and Linux, `X:\a\b` on Windows. Everything else is rejected:
relative and drive-relative paths (`C:foo`), UNC (`\\server\share`) and
device (`\\?\`, `\\.\`) prefixes, forward slashes on Windows, backslashes on
POSIX, NUL, empty, `.` and `..` segments, trailing separators, Windows device
names (`CON`, `NUL`, ...), Windows-illegal characters and trailing dots or
spaces. The parser also enforces the layout: `executableDir` and `resourceDir`
are inside `installRoot` (or equal to it), compared by whole segments (never by
string prefix; case-insensitively for ASCII on Windows), `shellExecutable` is a
direct child of `executableDir`, `installRoot` is not a filesystem root, and on
macOS `installRoot` ends in `.app`, `executableDir` is
`<installRoot>/Contents/MacOS` and `resourceDir` is
`<installRoot>/Contents/Resources`. A layout violation is `untrusted_path`.

Layouts:

- macOS: `X.app`; sidecars and the shell binary in `Contents/MacOS`, resources
  in `Contents/Resources`.
- Windows (NSIS or MSI): the install directory; the shell binary, sidecars
  (`<executable>.exe`) and, by default, resources sit there.
- Linux `.deb`/`.rpm`: `installRoot` is `/usr`, `executableDir` is `/usr/bin`
  and `resourceDir` is `/usr/lib/<product>`; there is no single install root.
- Linux AppImage is **not supported** in v1: its resources live under a
  per-run `/tmp/.mount_*` that does not exist while the app is closed, so
  nothing stable can be recorded or verified.

### locateInstallation

```ts
import { locateInstallation } from '@happyvertical/smrt-desktop';

const install = await locateInstallation({
  productId: 'smrt-notes',
  bundleId: 'com.happyvertical.smrt-notes',
});
// install.nodePath, install.bridgePath, install.shellExecutable, ...
```

The caller knows `productId` and `bundleId` (compiled in, or from a public file
shipped with the plugin). The function:

1. Computes the private state directory from `bundleId`, requires it to be a
   real directory (not a symlink) owned by the current user with no group or
   other permission bits, and reads `installation.json` with the private-file
   rules below. Absent means `not_installed`: a credential can only exist after
   the owner signed in through the app, so the app has necessarily run once and
   written its record. There is no scan of well-known install locations in v1.
2. Requires the record's `productId`, `bundleId` and `platform` to equal the
   caller's expectation (`identity_mismatch`).
3. Re-reads `smrt-bundle.json` and the sidecar manifest from the recorded
   `resourceDir`, parses them, and requires `productId`, `bundleId`,
   `productVersion` and `target` to equal the record (`identity_mismatch`:
   the app was updated and has not restarted yet; start the shell and retry).
   It then cross-checks the bundle against the sidecar manifest.
4. Re-derives `nodePath` (`<executableDir>/<node.executable>`, plus `.exe` on
   Windows) and `bridgePath` (`<resourceDir>/<bridge.entry>`) and requires
   them to stay inside `installRoot`.
5. Walks every path component from `installRoot` down to the manifests, the
   Node sidecar, the bridge and the shell binary. No component may be a
   symlink and `installRoot` must resolve to itself, so no ancestor is one
   either. On POSIX every component must be owned by the current user or root
   and not be group or other writable; the files must be regular files, and the
   Node sidecar and shell binary must carry an execute bit. Windows is
   lexical-only in TypeScript (see below). A missing file is `not_installed`;
   anything wrong is `untrusted_path`.
6. Returns a frozen `VerifiedInstallation`: `bundle`, `sidecar`, `platform`,
   `installRoot`, `executableDir`, `resourceDir`, `shellExecutable`,
   `shellDirectory`, `nodePath`, `bridgePath` and `healthRoute`.

Options `platform`, `env`, `homeDirectory`, `currentUid` and `fs` are test
seams. A consumer that spawns anything from the result should still re-run its
own checks right before the spawn: the walk narrows but cannot close the window
between verification and use.

Residual risk: the ownership and write-permission checks run on `installRoot`
and everything below it. The directories above `installRoot` are only checked
for symlinks, not for ownership or write permission, and the usual macOS
location is not owner-only (`/Applications` is `root:admin`, mode 0775). A
member of the `admin` group, or any process running as one, can therefore
rename or replace the install between locate and spawn. The walk does not
defend against a writer of an ancestor directory. A direct-parent
"group-writable and not sticky" rejection was considered and not added,
because it would reject the default `/Applications` install on a normal Mac.

### Private state directory

Private state lives in `<app_local_data_dir>/.desktop-shell/` (mode 0700, owned
by the current user; the shell creates it). `resolveAppLocalDataDir(bundleId,
{ platform, env, home })` computes `app_local_data_dir` exactly as Tauri does:

- macOS: `~/Library/Application Support/<bundleId>`
- Windows: `%LOCALAPPDATA%\<bundleId>`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/<bundleId>` (a relative
  `XDG_DATA_HOME` is ignored, as the XDG specification says)

Windows uses the machine-local `LOCALAPPDATA`, never the roaming `APPDATA`: a
pid, socket or install path must not follow a user to another machine.
`resolveDesktopShellDir` appends `.desktop-shell`. Missing or non-absolute
environment values fail closed (`invalid_environment`) and never fall back to a
guess.

Custody rules for files in that directory, implemented by the internal
`readPrivateFile` and `writePrivateFileAtomic` helpers all contracts reuse:

- Files are mode 0600. Readers open with `O_RDONLY|O_NOFOLLOW` and validate
  `fstat` on the open descriptor (regular file, owned by the current user,
  `mode & 0o077 === 0`, size cap), never `stat` then `open`.
- Writers use `tmp (O_CREAT|O_EXCL|O_NOFOLLOW, 0600) -> write -> fsync -> rename
  -> fsync(dir)`; a failed write removes only a temp file it created, and an
  existing symlink at the destination is replaced, never followed.
- `O_NOFOLLOW` covers only the final path component, so the directory itself is
  checked with `lstat` (a symlink or wrong owner or mode is rejected).
- Clients never delete or repair records they did not write.

**Windows limitation (design finding F8).** Node cannot read Windows ACLs, and
POSIX uid and mode bits do not exist there. On Windows the TypeScript checks are
lexical (the path rules above), existence and file kind, and reparse-point
(symlink or junction) rejection; custody relies on the default ACLs of
`%LOCALAPPDATA%`. Real ACL and SID verification belongs in the native shell.
This is a documented residual risk, not a guarantee.

### Supervisor rendezvous

A launcher that needs the app running asks `createFileRendezvous` for the
supervisor's state instead of guessing from pids or ports.

```ts
import {
  createFileRendezvous,
  locateInstallation,
} from '@happyvertical/smrt-desktop';

const rendezvous = createFileRendezvous({
  locate: () => locateInstallation({ productId, bundleId }),
});
const result = await rendezvous.ensureReady({ timeoutMs: 60_000 });
if (result.state === 'ready') connectTo(result.origin);
```

**Authority is the control channel, not a file.** The shell serves an
owner-only channel (a Unix domain socket on macOS and Linux, a named pipe on
Windows) and publishes `instance.json` in the private state directory as a
pointer and a cache. A client trusts an instance only after the channel
answers `status` with the `instanceNonce` recorded in `instance.json`. It
never infers liveness from the pid or from a file existing, so a stale record
left by a crash, a recycled pid or a record written by someone else cannot
make a dead instance look alive.

**Instance record v1** (`instance.json`, written atomically by the shell with
the private-file rules above; fixture `examples/instance.json`):

| Field | Meaning |
| --- | --- |
| `version` | `1` |
| `productId`, `bundleId` | identity; must equal the installation's |
| `instanceNonce` | 32 lowercase hex characters, new for every shell process |
| `pid` | the shell process id; diagnostic only, never used for liveness |
| `shellVersion` | semantic version of the shell binary |
| `startedAt`, `updatedAt` | ISO-8601 UTC; process start and last phase change |
| `control` | `{kind:'unix', path}` or `{kind:'pipe', name}` |
| `state` | `starting`, `ready` or `failed` |
| `origin` | present if and only if `ready`; exactly `http://127.0.0.1:<1..65535>` (no `localhost`, no IPv6, no path, userinfo or leading zeros) |
| `failure` | present if and only if `failed`; a shell failure code |

The shell rewrites it on every phase change (`ready` only after the
supervisor's confirmation window). On orderly quit it removes the socket and
leaves the record, because deleting it would race a newly starting shell: the
next client finds the endpoint gone, treats the record as stale and starts the
shell. Clients never write, rename or delete the record, a socket, a lease or
a lock.

**Endpoint names are unguessable, not well known.** The socket or pipe name
contains 128 random bits chosen per shell start and is published only inside
the 0700 private directory (`deriveControlEndpoint`): POSIX
`<directory>/c-<32 hex>.sock`, Windows
`\\.\pipe\smrt-<16 hex of sha256(bundleId)>-<32 hex>`. There is no name an
attacker could squat in advance. `sun_path` is 104 bytes on macOS, so the
private state directory under `~/Library/Application Support` is normally too
long for the socket: the shell places it in a short per-user 0700 directory
(the per-user temp directory on macOS, `$XDG_RUNTIME_DIR` on Linux) and names
that path in the record. A client accepts any directory that passes the checks
below, so this is the shell's choice.

**Control protocol v1.** One UTF-8 JSON object per line (`\n`-terminated), at
most 4096 bytes excluding the terminator, closed schema, duplicate keys
rejected, unknown `v` or `op` rejected, one request per connection (the server
closes after its answer). This contract defines two operations; the credential
handoff adds a third (`acquire-credential`, see
[Control channel: `acquire-credential`](#control-channel-acquire-credential))
without changing `coreControlCodec`, because operations are data
(`ControlOpSpec`), a codec is built from a list of them (`createControlCodec`),
and handlers register in an open registry (`createControlHandlerRegistry`).

| Request | Answer |
| --- | --- |
| `{"v":1,"op":"status"}` | the current state, immediately |
| `{"v":1,"op":"ensure-ready","timeoutMs":N}` | the state once `ready` or `failed`, or `starting` after `N` ms (1 to 600000) |

Success answers are `{"v":1,"ok":true,"state":"ready","instanceNonce":"...",
"productId":"...","origin":"http://127.0.0.1:N"}`, the same with
`"state":"starting"` (no origin), or `"state":"failed","code":"<failure code>"`.
Refusals are `{"v":1,"ok":false,"code":"unsupported_version" |
"unsupported_op" | "bad_request" | "too_large" | "forbidden" | "internal"}`.
No answer carries a bearer or any secret.

**Peer identity.** The real check belongs to the Rust shell: it reads the
peer's credentials before it reads a byte (`SO_PEERCRED` on Linux,
`getpeereid` on macOS, `GetNamedPipeClientProcessId` plus the token user SID on
Windows), creates the Windows pipe with `FILE_FLAG_FIRST_PIPE_INSTANCE`,
`PIPE_REJECT_REMOTE_CLIENTS` and a current-user-only DACL, and creates the
socket with mode 0600. Node can do none of this: a `net.Socket` cannot report
its peer's uid or SID, and a client cannot learn who owns the listening end. So
`sendControlRequest` and the TypeScript reference server
(`serveControlChannel`) perform no peer verification. What they do instead:

- the reference server refuses to listen unless the socket's directory is a
  real directory owned by the user with mode 0700, never replaces an existing
  path, and chmods the socket 0600, so only the same OS user can connect;
- a same-user process is not excluded by any of this (see "Same-user
  processes" in the residual risks): it can read the 0600 `instance.json`
  (nonce, origin and endpoint), reach the owner-only channel and speak the
  protocol. The nonce proves the *server* is the recorded instance; it does
  not authenticate the *caller*;
- the client, before connecting, requires the recorded socket's directory to
  be a real 0700 directory owned by the user and the socket itself to be a
  socket (not a symlink) owned by the user with no group or other permission
  bits, and requires the peer to prove it is the recorded instance by echoing
  the `instanceNonce`;
- on Windows the TypeScript checks are the pipe name grammar and the nonce;
  ACL and SID verification live in the shell (finding F8, residual risk).

**Result type.** `status()` and `ensureReady()` resolve with a closed union
(`RendezvousResult`):

| `state` | Meaning |
| --- | --- |
| `ready` | the channel proved the recorded instance and reported `ready`; carries `origin`, `instanceNonce`, `productId` |
| `starting` | `status()` only: the instance is up and not ready yet |
| `failed` | the instance or this client failed; carries a `code` (below) |
| `not_installed` | `locate()` found no installed product |
| `not_running` | no live instance (`status()`, or `ensureReady({start:false})`) |
| `untrusted_state` | the installation, record, directory, socket or peer failed a custody or protocol check; nothing was started |
| `timeout` | not ready within the budget |

Cancelling with the `AbortSignal` rejects with the signal's reason. A result
never contains a bearer, a pid or a path.

**Failure codes** (`RendezvousFailureCode`, closed). The Rust supervisor today
reports `Failed(String)`, free text for the tray. A client must not branch on
it, so the channel and `instance.json` carry a code. The Rust follow-up adds a
`FailureCode` enum with these exact wire names; until then
`failureCodeFromSupervisorMessage` maps the current texts for Node-based shells
and test doubles:

| Code | Reported by | Meaning (current supervisor text it replaces) |
| --- | --- | --- |
| `lease_held` | shell | another live process holds the runtime writer lease or operation lock ("...writer lease or operation lock") |
| `restart_exhausted` | shell | restart budget spent ("gave up after N restarts"); only the tray Restart recovers |
| `sidecar_missing` | shell | the sidecar could not be launched ("could not start the sidecar") |
| `health_failed` | shell | never healthy, or the health route redirects ("did not become healthy", "health route redirects") |
| `port_unavailable` | shell | no loopback port could be selected or bound ("port was taken", "could not select a loopback port") |
| `stop_unconfirmed` | shell | the previous child's exit could not be confirmed ("could not be stopped") |
| `internal_error` | shell | the supervisor itself failed ("internal supervisor error") |
| `unknown` | shell | anything else |
| `launch_failed` | client | the client could not start the shell binary |
| `instance_mismatch` | client | the channel answered for another instance or product than recorded, or the record and channel disagree on state or origin (after one re-read) |
| `identity_mismatch` | client | the installed product's identity differs from the record (benign after an update until the app restarts) |
| `unsupported_contract` | client | a record or channel speaks a contract version this client rejects |

**`ensureReady({ timeoutMs = 60000, start = true, signal })`:**

1. `locate()` the installation (contract a). `not_installed` and the locate
   errors map to the results above.
2. Read `instance.json` with the private-file rules. Absent: go to step 5.
3. Vet the endpoint (directory, socket type, owner, mode). Failure:
   `untrusted_state`. An untrusted record means someone tampered with the
   private directory, so no second shell is started on top of it.
4. Ask `status`. No listener (missing, refused, no answer) means the record is
   stale: go to step 5. A nonce, product or origin disagreement is re-read
   once, then `instance_mismatch`. `ready` is returned. `failed(code)` is
   returned and never retried: a live shell that failed is not a reason to
   start another. `starting` waits with `ensure-ready` for the remaining
   budget.
5. With `start: false`: `not_running`. Otherwise spawn the shell executable
   once with `--smrt-background` (no shell, detached, ignored stdio, hidden
   window, `cwd` the install root, environment limited to an allowlist such as
   `HOME`, `LOCALAPPDATA`, `XDG_*`, `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`;
   never the launcher's environment wholesale), then poll with backoff until
   `ready`, `failed`, `untrusted_state`, the budget (`timeout`) or the signal.

**One writer.** A client only reads, talks to the channel and spawns the shell
binary. Racing launchers may each spawn the shell: the single-instance plugin
forwards the second start to the first and exits; if the plugin cannot run
(for example Linux without a D-Bus session bus) the second shell's sidecar
fails `lease_held` against the runtime writer lease and that shell ends
`failed` without writing the record. The runtime lease, not this contract, is
the backstop, and a shell must not write `instance.json` unless it holds the
single-instance lock. Within one `createFileRendezvous` object concurrent calls
share a single in-flight spawn.

**What a client must never do:** delete or "repair" `instance.json`, a socket,
`writer.lease` or `operation.lock`; retry a `failed(lease_held)`; infer
liveness from a pid; or put anything from the channel into a log line beyond
the closed result states.

**Test double for the launcher.** The reference server is exported:
`createReferenceSupervisor` (a pure `starting` / `ready` / `failed` state
machine), `createReferenceRegistry`, `startReferenceShell` (binds a fresh
endpoint, serves `status` and `ensure-ready`, republishes `instance.json` on
every phase change and leaves it on `close()`), and `serveControlChannel` with a
handler registry. It models the Rust shell's observable behavior, not its
peer checks or its single-instance lock.

### Native credential handoff

The owner mints a local MCP bearer in the signed-in desktop webview (#4726).
The bearer must reach the MCP bridge that an assistant host (Claude, ChatGPT)
spawns, without ever sitting in argv, in the environment, in browser storage,
in a log, or in a file other than the OS secret store. Everything in this
section is exported from the package root except the webview helper, which is
the browser-safe subpath `@happyvertical/smrt-desktop/webview`.

```text
owner webview --fetch POST /api/local/mcp-credentials (cookie, same origin)--> sidecar
      |  raw response text
      +--invoke('desktop-credential-put', { slotId, body })--> shell (Rust)
                          validates, stores in the OS secret store, marks the slot
launcher --control channel: acquire-credential(instanceNonce, origin)--> shell --> token
launcher --inherited anonymous pipe, fd 3: { token, origin }--> bridge
                          (the bridge asks for a refresh over the same pipe)
```

This package contains the contract and a reference implementation of each
step the shell mirrors in Rust (parsers, the custody layer, the
`acquire-credential` handler) plus the parts that run in JavaScript (the
webview helper, the provider, the fd 3 codec and the bridge spawn helper). The
OS keychain implementation, the Tauri commands and the control socket are the
shell's (see the follow-up list at the end of this section).

#### Slot record (`mcp-slot.json`)

One slot per installation in v1. The record holds no secret:

```json
{
  "version": 1,
  "slotId": "2c70f518-b95a-445b-a75e-8126ae7c032a",
  "scopes": ["notes.read"],
  "expiresAt": "2026-12-01T12:00:00Z",
  "state": "minted"
}
```

- `slotId`: opaque lowercase UUIDv4 chosen by the desktop app, never by the
  server. `newSlotId()` generates it; the record is written (`writeSlotRecord`:
  temp file, fsync, rename, fsync the directory, mode 0600) **before the first
  request** for that id, as #4726 requires, so a lost response can be retried
  with the same id.
- `scopes`: permission slugs (1 to 64, each up to 128 printable ASCII
  characters without space, `"` or `\`, no duplicates).
- `expiresAt`: `null` while the slot is only reserved, then the expiry of the
  credential committed to custody.
- `state`: `minted` (id reserved; a credential is committed once `expiresAt` is
  set), `revoking` (disconnect started, the server revoke not yet confirmed:
  the shell stops serving the credential at once and retries the revoke), or
  `revoked` (the server confirmed; permanent for the id, so the next connect
  uses a new id).

`parseSlotRecord` / `serializeSlotRecord` are strict (closed schema, duplicate
keys rejected, `version: 1` only) and `readSlotRecord` opens with
`O_NOFOLLOW` and validates the descriptor like every private state file. See
[`examples/mcp-slot.json`](examples/mcp-slot.json) (shared with the Rust tests).

#### Lifecycle

- **Mint.** The webview POSTs `{ action: 'put', id, scopes, expiresInSeconds }`
  to `/api/local/mcp-credentials` (the #4726 route: the `put` action is sent as a
  `POST`). The success reply `{ id, token, scopes, expiresAt }` goes, as raw text,
  to `desktop-credential-put`. `parseMintResponse(body, slotId)` is the
  reference validator the shell mirrors: strict JSON, exactly those four keys,
  `id` equal to the slot, the token matches `^smrt_mcp_[A-Za-z0-9_-]{43}$`, the
  scopes are valid, `expiresAt` is at least 60 seconds ahead, body at most
  12 KiB. The token becomes a `SecretString` immediately.
- **Rotate.** A new PUT on the same slot id replaces the bearer atomically; only
  the latest committed write verifies on the server (#4726). Custody replaces
  the item atomically, the `acquire-credential` handler reads custody on every
  call, and running bridges see a 401 and ask for a refresh over fd 3. Rotate
  when the remaining lifetime drops below `max(lifetime / 4, 24 h)`.
- **Retry.** A network error, an unreadable response body, a 5xx, 408 or 429
  repeats the PUT with the **same** slot id (bounded, three attempts by
  default). A native rejection after a 200 also retries the PUT, because a
  fresh PUT replaces the lost bearer without leaving a second active one. A 409
  `slot_unavailable` (revoked slot) asks the shell for a **new** slot id
  (`desktop-credential-slot { action: 'replace' }`), at most twice. 403 and
  other 4xx are not retried.
- **Revoke (disconnect).** The server revoke comes first (`{ action: 'revoke',
  id }`; a `revoked` reply and a 409 both count as done), then
  `desktop-credential-forget { slotId, revoked: true }` makes the shell delete
  the item and mark the slot `revoked`. If the server cannot be reached the
  helper still tells the shell (`revoked: false`) so the slot becomes `revoking`
  and the credential is no longer served; the next connect or disconnect
  finishes the revoke first. A credential is therefore never forgotten while
  the server still honors it.
- **Expiry.** A credential within 30 seconds of `expiresAt` is treated as
  expired: `acquire-credential` answers `credential_invalid` ("open the app to
  reconnect") rather than hand out a bearer that dies in flight.

#### Webview helper (`@happyvertical/smrt-desktop/webview`)

```ts
import { invoke } from '@tauri-apps/api/core';
import {
  connectDesktopAssistant,
  disconnectDesktopAssistant,
  getDesktopAssistantStatus,
} from '@happyvertical/smrt-desktop/webview';

const status = await connectDesktopAssistant({
  invoke,
  fetch: window.fetch.bind(window),
  scopes: ['notes.read'],
  expiresInSeconds: 30 * 24 * 60 * 60,
});
// { state: 'connected', slotId, scopes, expiresAt }  (never a token)
```

`fetch` and Tauri `invoke` are injected, so the helper has no dependency and
imports no Node built-in (the build and a test check the dist file). It sends
the request with `credentials: 'same-origin'`, `cache: 'no-store'`,
`redirect: 'error'` and `referrerPolicy: 'no-referrer'` to a relative URL (no
`location`, no `URL`), hands `await res.text()` untouched to
`desktop-credential-put`, and returns only non-secret status. It does not touch
`localStorage`, `sessionStorage`, IndexedDB, cookies, `console`, `location`,
`history` or URL construction (a test booby-traps those globals), and every
rejection from `fetch` or `invoke` is replaced by a `DesktopContractError`
with a fixed message (the original, which could echo a body, is dropped, never
chained).

The helper calls four native commands. **No command returns a token to
JavaScript**:

| Command | Arguments | Returns (non-secret) |
| --- | --- | --- |
| `desktop-credential-slot` | `{ action: 'ensure' \| 'replace' }` | `{ slotId, state, scopes, expiresAt }`; persists a new slot before returning |
| `desktop-credential-put` | `{ slotId, body }` (raw response text) | `{ status: 'active', scopes, expiresAt }` |
| `desktop-credential-status` | `{}` | the slot (as above) or `null` |
| `desktop-credential-forget` | `{ slotId, revoked }` | `{ status: 'revoked' \| 'revoking' }` |

The shell must grant these four commands, and only these, to the `main` window
for the sidecar's loopback origin (`remote.urls: ["http://127.0.0.1:*"]` in a
dedicated `desktop-credential` capability). This reverses the posture that
remote content gets no IPC and is owner decision D1 of the design. At call time
the shell must check that the invoking webview's URL origin equals the
supervisor's *current* ready origin exactly (the capability glob matches any
port), that `slotId` is the persisted slot, and that the body is at most 12 KiB
and valid per `parseMintResponse`.

#### Control channel: `acquire-credential`

`createCredentialControlHandler({ custody, slot, current })` is the reference
handler. It takes a request `{ v: 1, op: 'acquire-credential', instanceNonce,
origin }` and returns `{ ok: true, lease }` or `{ ok: false, code }`, and it
never throws. It is written against a minimal structural `ControlContext {
instanceNonce, origin }` and imports nothing from the control protocol; the
wiring below registers it. Checks, in order:

1. `instance_mismatch` when the nonce or origin differs from the running
   instance (or the instance is not ready). Custody is not touched, so a stale
   launcher cannot trigger a keychain read.
2. `credential_unavailable` when there is no slot, the slot has no committed
   credential, custody holds no item, or the store fails.
3. `credential_invalid` when the slot is `revoking` or `revoked`, the item is
   malformed, or the credential is expired.

`encodeAcquireCredentialResponse` / `parseAcquireCredentialResponse` are the
wire form (`{"v":1,"ok":true,"origin":"…","token":"…","expiresAt":"…"}` or
`{"v":1,"ok":false,"code":"…"}`); the bearer appears in a success reply and
nowhere else.

**On the wire.** The op is added to contract (b)'s extension points, not to its
core. `credentialControlOp` is the `ControlOpSpec` (request closed to `v`,
`op`, `instanceNonce`, `origin`; the success body is parsed by
`parseAcquireCredentialResponse`), and `credentialControlCodec` is
`createControlCodec` over `status`, `ensure-ready` and `acquire-credential`
with the extra error codes `credential_unavailable`, `credential_invalid` and
`instance_mismatch`. `coreControlCodec` is unchanged: a core-only client cannot
build the request, and a core-only server answers it `unsupported_op`. The
codec encodes the success body with `encodeAcquireCredentialResponse` (a
`SecretString` would serialize as `[REDACTED]` through the generic path) and
re-parses its own line, so the bearer is revealed in one place and appears in
the `ok: true` body of this op and nowhere else; no rendezvous type
(`RendezvousResult`, `InstanceStateResponse`, `instance.json`) can carry it.

A server wires it with `createCredentialReferenceRegistry(supervisor, {
custody, slot })`, which registers `status`, `ensure-ready` and the handler,
passing `current: referenceControlContext(supervisor)` so the nonce and origin
the handler compares against are the serving instance's own (and `null`, hence
`instance_mismatch`, while it is not `ready`). Hand the registry and the codec
to `startReferenceShell({ ..., registry, codec: credentialControlCodec })`; a
different server uses `registerAcquireCredential(registry, handler)` on a
registry typed `ControlHandlerRegistry<CredentialControlRequest,
CredentialControlResponse>`. `src/credentials/end-to-end.test.ts` runs the
whole path over a real unix socket.

`createControlChannelCredentialProvider({ send })` is the launcher side. `send`
is injected (`createControlChannelSend(endpoint)` implements it over the
rendezvous transport and `credentialControlCodec`); the provider validates
the nonce and origin before sending, applies a timeout (default 2 s) and the
caller's `AbortSignal`, decodes the reply strictly, requires the reply origin
to equal the requested origin, and refuses an expired bearer. Every transport
or parse failure is `credential_unavailable` with the cause dropped.

#### fd 3 frame protocol and bridge spawn

The launcher hands the bearer to the bridge over an anonymous pipe inherited
at descriptor 3 (a socketpair on POSIX, a named pipe on Windows via libuv's
extra stdio, so both directions work everywhere). argv carries only the
non-secret `--credential-fd=3`, and the environment is built from scratch.

NDJSON, one frame per line, at most 2048 bytes including the newline, `"v":1`,
closed schemas, duplicate keys rejected. Each side accepts only the other
side's frames (`parseHandoffFrame(line, direction)`):

| Direction | Frame |
| --- | --- |
| launcher to bridge | `{"v":1,"type":"credential","seq":0,"origin":"http://127.0.0.1:N","token":"smrt_mcp_…","expiresAt":"…"}`; `seq` 0 is the initial frame, a higher `seq` is a refresh after rotation, expiry or a sidecar port change |
| launcher to bridge | `{"v":1,"type":"unavailable","seq":N,"code":"credential_invalid" \| "credential_unavailable" \| "instance_mismatch"}` |
| bridge to launcher | `{"v":1,"type":"refresh"}` after a 401, a 403 or a refused connection (the bridge rate-limits it to one per ten seconds) |

`HandoffFrameDecoder` reassembles frames from pipe chunks, bounds buffering at
the cap and poisons itself on the first violation.
`spawnBridgeWithCredential({ command, args, env, lease, refresh })` spawns the
child with `stdio: [..., 'pipe']`, no shell, and exactly the given `env`; it
refuses (`handoff_failed`) if the bearer appears in the command, the arguments,
the environment or the working directory, refuses a lease whose origin is not
`http://127.0.0.1:<port>`, writes the initial frame before the child can read,
answers `refresh` requests through the `refresh` callback (typically
`provider.acquire` after a `status` check), serializes concurrent requests, and
closes the pipe when the child exits or misbehaves.

The bridge side (`--credential-fd` in app-cli) is out of scope here: it needs
only `parseHandoffFrame`/`HandoffFrameDecoder` (or the 30 lines duplicated),
and when `--credential-fd` is present it must ignore `<PREFIX>_TOKEN`,
`<PREFIX>_SERVER_URL` and config files, pin the origin from the frame and keep
refusing redirects. It must also mark fd 3 close-on-exec (`FD_CLOEXEC`) as soon
as it has read the frame, or never spawn child processes while fd 3 is open;
otherwise a child inherits the descriptor and the unread or refresh channel.

#### SecretString rules

The bearer is a `SecretString` from the moment it is parsed. `reveal()` is
called in exactly three source files, enforced by a test that scans the
sources: `credentials/custody.ts` (serializing the item), `credentials/
control-handler.ts` (the control wire reply) and `credentials/handoff-frame.ts`
(the fd 3 frame and the argv/env guard `containsSecret`). Results, leases and
stored credentials contain a `SecretString`, so `JSON.stringify`,
`util.inspect`, `console.log`, template literals and `structuredClone` of any
of them are safe. `SecretItemStore` buffers are zeroed after use (JavaScript
strings cannot be, see the residual risks).

#### Credential error codes

All are `DesktopContractError` codes with fixed, value-free messages; `field`
is a static schema name.

| Code | Meaning |
| --- | --- |
| `credential_unavailable` | no slot, never minted, custody missing or failing, transport failure: connect the assistant in the app |
| `credential_invalid` | expired, revoked or revoking, or a malformed stored item: reconnect in the app |
| `instance_mismatch` | the request names another app instance, origin or malformed nonce |
| `invalid_mint_response` | the mint reply is not the documented success reply (`field` names the part) |
| `invalid_handoff_frame`, `handoff_frame_too_large` | fd 3 frame violations |
| `handoff_failed` | the bridge could not be spawned safely, or the pipe is closed |
| `slot_unavailable` | the server keeps refusing new slot ids, or a pending revoke is unconfirmed |
| `credential_forbidden` | not the signed-in owner (403) |
| `credential_rejected` | other 4xx, or invalid helper input |
| `credential_request_failed` | network or server failure after the retry budget, or aborted |
| `native_rejected` | the shell rejected the body or a command failed |
| `invalid_native_response` | a native command replied outside its schema |

#### Threat model

Every row names the mitigation and the exact tests (`file: test name`) that
close it. Rows whose enforcement point is the Rust shell or contract (b) say
so; those parts are not claimed closed by this package.

| # | Threat | Mitigation | Closing test(s) |
| --- | --- | --- | --- |
| T1 | Same-user malware reads the keychain item | The shell stores the item in the OS secret store (macOS: created by the signed shell, `WhenUnlockedThisDeviceOnly`, non-synchronizable). This does not stop a same-user process: it can read `instance.json`, connect to the owner-only channel and call `acquire-credential`, and the shell itself reads the keychain on its behalf, so no keychain ACL prompt applies. Windows/Linux likewise have no same-user boundary. Residual (see "Same-user processes"); revoke/rotate is the recovery. Scopes and lifetime are bounded by the owner. Custody touches only `mcp-credential.<uuid>` names. | `credentials/custody.test.ts`: `T1: custody only touches mcp-credential.<uuid> item names`. Item attributes are asserted in the shell's macOS test (follow-up). |
| T2 | Another OS user | Private directory 0700, files 0600, readers validate `fstat` (owner, mode); control-channel peer uid/SID check and pipe DACL are the shell's and contract (b)'s. | `credentials/slot-record.test.ts`: `T2: readSlotRecord rejects a foreign-owned, group-readable or symlinked record`. Peer-credential rejection is a Rust test (follow-up). |
| T3 | Token in argv / `ps` | The bearer is never an argument (`--credential-fd=3` only); the spawn helper refuses a command, argument or cwd that contains it. | `credentials/bridge-spawn.test.ts`: `T3: argv and env passed to the spawner never contain the token`; `T3/T4: refuses to spawn when the token is in argv, env, command or cwd`; `T3: ps shows no token in the child command line` (real child). |
| T4 | Token in the environment (`/proc/<pid>/environ`) | The child environment is exactly what the launcher passes, never inherited; the bridge in fd mode ignores `<PREFIX>_TOKEN`. | `credentials/bridge-spawn.test.ts`: `T4: the child environment as the OS reports it holds no token` (`/proc/<pid>/environ` on Linux, `ps eww` on macOS, real child with a real fd 3 pipe); `delivers the initial frame over fd 3 and keeps the token out of argv and env`; `credentials/end-to-end.test.ts`: `hands the minted token from the shell to the bridge over fd 3 and nowhere else`. |
| T5 | Crash dumps and logs | The token lives in a `SecretString` until the three reveal sites; diagnostics are fixed text; buffers are zeroed. | `credentials/leak.test.ts`: `T5: SecretString is not serialized by JSON, inspect, String, template, structuredClone or console`; `T5: errors built with secrets in their context do not retain them`; `T5: every credential error message is fixed, value-free text`; the describe `T5/T11: every exported parser and handler, fed token-bearing invalid input`; `reveal() is called only by custody serialization, the wire encoders and the secret guard`. |
| T6 | Webview XSS reaching the IPC command | No command returns a token; the helper never stores, logs or builds URLs from the body; the shell checks the webview origin equals the current ready origin, the slot id, and the body (follow-up). XSS in this origin already holds the session cookie and can mint itself, so the IPC path grants nothing new. | `webview/webview.test.ts`: `T6: touches no storage, cookie, console, URL or location API`; `T6: has no path to those APIs in its source or its import closure`; `mints with a same-origin POST and passes the RAW response text only to the put command`. Origin/slot/body rejection is a Rust test (follow-up). |
| T7 | Replay after rotation | Server: only the latest write verifies (`app-runtime/src/local-mcp-tokens.test.ts`: `mints, rotates, expires and revokes a private owner slot without colliding with operator tokens`). Custody replaces atomically and the handler reads it on every call; the pipe delivers the new bearer on refresh. | `credentials/control-handler.test.ts`: `T7: after rotation the handler returns only the latest bearer`; `credentials/bridge-spawn.test.ts`: `T7: a refresh request after a simulated 401 delivers the rotated token`; `credentials/custody.test.ts`: `replaces atomically: a later put wins and old bytes are gone`; over a real socket, `credentials/end-to-end.test.ts`: `yields only the latest token after a rotation`. |
| T8 | Confused deputy via the control channel | `acquire-credential` is bound to the current `instanceNonce` and `origin` and refuses before touching custody. This defeats a stale or wrong-instance caller, not a same-user one: the nonce and origin are readable by any process of the same OS user (0600 `instance.json`), so they do not bound that caller. One request per connection is enforced; the peer check is the shell's, and today it is uid/SID only (see "Same-user processes"). | `credentials/control-handler.test.ts`: `T8: wrong nonce or origin yields instance_mismatch without touching custody`; over a real socket, `credentials/end-to-end.test.ts`: `answers a wrong instance nonce or origin with instance_mismatch`. Foreign peer is a Rust test (follow-up). |
| T9 | TOCTOU on state files | Readers open `O_NOFOLLOW` and validate the descriptor; writers use temp (`O_EXCL`) plus rename; clients never repair or delete. | `credentials/slot-record.test.ts`: `T9: a symlink swapped in for the record is never followed or repaired`; `persists the slot before the first request can be made` (write order); the stage-1 `internal/private-file.test.ts`. |
| T10 | Windows named-pipe squatting | Random pipe name published in the private directory, `FILE_FLAG_FIRST_PIPE_INSTANCE`, DACL: contract (b) and the shell. This contract only guarantees that the provider opens no endpoint of its own. | `credentials/provider.test.ts`: `T10: talks only through the injected send and never opens an endpoint itself`. Name grammar belongs to contract (b)'s tests; the "second `CreateNamedPipe` fails" test is a Windows Rust test (follow-up). Residual: a Node client cannot query the server pid/SID. |
| T11 | Token in error messages | Code-only errors; parsers never echo input; the webview helper replaces every `fetch`/`invoke` rejection with a fixed code and does not chain it. | `credentials/mint-response.test.ts`: `T11: never echoes the body or the token in any failure`; `webview/webview.test.ts`: `T11: a token-bearing malformed body yields a fixed-code error without the token`; `credentials/leak.test.ts`: `the webview helper maps token-bearing failures to fixed codes` and the `T5/T11` describe. |
| T12 | Port squatting after ready | The credential is released only for the nonce and origin the channel confirms; the provider requires the reply origin to equal the requested origin. | `credentials/control-handler.test.ts`: `T12: an origin that differs from the running instance never gets a token`; `credentials/provider.test.ts`: `T12: rejects a lease whose origin differs from the origin it asked about`. Nonce echo in the health route is optional (design D5). |
| T13 | Credential sent to a non-owned endpoint | Origin grammar `http://127.0.0.1:<1..65535>` everywhere (no `localhost`, no `[::1]`, no https, no path or userinfo); the bridge pins the origin from the frame. | `credentials/handoff-frame.test.ts`: `T13: only the exact loopback origin grammar is accepted`; `credentials/provider.test.ts`: `T13: only the loopback origin grammar is ever accepted in a reply`; `credentials/bridge-spawn.test.ts`: `T13: refuses a lease for a non-loopback origin`. |
| T14 | Roaming profile copies state to another machine | State lives only under `app_local_data_dir` (`LOCALAPPDATA`, never `APPDATA`). | Stage-1 `install/locations.test.ts`: `uses LOCALAPPDATA and never the roaming APPDATA on Windows`. |

#### Residual risks

- **Webview JavaScript.** The bearer exists as an immutable JS string in the
  page realm between `res.text()` and garbage collection. Script running in
  that realm (XSS, a compromised dependency) can wrap `fetch`, `Response.text`
  or `invoke` and read it, and the WebView network inspector shows it while
  devtools are open. The mitigations are a strict CSP, devtools off in release
  builds, no storage, and the argument that the same script could mint its own
  token with the session cookie. The stronger option (design D1-B: the shell
  mints natively with the webview cookie so the token never enters JS) is not
  implemented.
- **Same-user processes.** Any process of the same OS user can read the 0600
  `instance.json` (instance nonce, origin, control endpoint), connect to the
  owner-only control channel and call `acquire-credential`. The shell reads the
  keychain itself, so the macOS keychain ACL never prompts for that caller, and
  the nonce is not a secret against it. On Windows and Linux any same-user
  process can additionally read the OS store entry directly, and
  `ptrace`/`task_for_pid` (restricted by Yama and the hardened runtime, not
  eliminated) can read the launcher or bridge memory. The recovery is
  revoke/rotate of the slot (a rotation invalidates a token a stranger
  obtained). Follow-up (optional, Rust shell): verify the peer's code identity
  before reading custody (macOS audit token plus `SecCode` validation against
  the bundled binaries; on Windows the peer image path), which would let the
  shell refuse unrelated same-user callers. Until then this is a stated
  residual risk. The fd 3 pipe removes the bearer from `argv` and `environ`;
  it removes it from child processes only if the bridge marks fd 3
  close-on-exec (or never spawns children while it is open). It never removes
  it from memory.
- **Memory.** JavaScript strings cannot be zeroed; `SecretString` limits
  accidental serialization, not memory inspection or a heap snapshot.
- **The control channel** relies on peer-uid/SID checks in the shell. The
  reference handler cannot enforce them.
- **Bridge behavior** (ignoring env in fd mode, pinning the origin, rate
  limiting refresh) is app-cli's and is not enforced by this package.

#### Shell and elsewhere (follow-ups, not in this package)

- Rust shell: the OS secret store behind `SecretItemStore` (shared with the
  vault keys of #4792), the four commands and the `desktop-credential`
  capability with the checks above, a per-slot mutex, the control server and
  its peer-credential checks, mirrors of `parseSlotRecord`/`parseMintResponse`
  tested against `examples/mcp-slot.json`.
- app-cli: `--credential-fd` mode using the frame codec (a dependency on this
  package, or a copy of the 30-line codec).
- #4729: env to fd 3, narrow the origin grammar, wire the control channel.

### Mapping to `LauncherProvider`

One table maps this package onto the launcher (#4791). `connectInstance` maps a
`RendezvousResult` from `createFileRendezvous(...).ensureReady()`;
`acquireCredential` maps the credential provider.

| Source | Result | `LauncherProvider` outcome |
| --- | --- | --- |
| `ensureReady()` | `ready` | `{ origin }`; keep `instanceNonce` and `origin` for the credential request |
| `ensureReady()` | `not_installed` | `missing_install` |
| `ensureReady()` | `failed` with `unsupported_contract` | `unsupported_contract` |
| `ensureReady()` | every other `failed`, `not_running`, `untrusted_state`, `timeout` | `stale_instance` |
| `provider.acquire(...)` | a lease | `{ token, release }` (see the notes below) |
| `provider.acquire(...)` | `credential_unavailable` | "connect the assistant in the app" (never connected) |
| `provider.acquire(...)` | `credential_invalid` | "connect the assistant in the app" (expired or revoked: reconnect) |
| `provider.acquire(...)` | `instance_mismatch` | the rendezvous answer went stale: re-run `ensureReady` once and retry |
| `provider.acquire(...)` | any other `DesktopContractError` | a launcher fault, not a user action |

`unexpected_endpoint` cannot arise from a `ready` result: the origin grammar
(`http://127.0.0.1:<port>`) is enforced by the record and protocol parsers, and
a violation surfaces as `untrusted_state`.

- `acquireCredential(context)` builds the provider once per instance with
  `createControlChannelCredentialProvider({ send: createControlChannelSend(endpoint) })`,
  where `endpoint` is the `control` endpoint of the `instance.json` the
  rendezvous vetted, and calls `provider.acquire({ instanceNonce, origin,
  signal })` with the nonce and origin the rendezvous reported for the same
  instance. It returns `{ token: lease.token.reveal(), release }` **only** as
  long as #4791 still passes the bearer as `<PREFIX>_TOKEN`. Once #4729 moves
  to fd 3, use `spawnBridgeWithCredential` instead and drop the env handoff;
  the launcher's `childEnvironment` must then contain no token.
- #4791 accepts `localhost` origins; this contract allows only
  `http://127.0.0.1:<port>`, so #4729 has to narrow `LOOPBACK_HOSTS`.
- `release` has nothing to release for the pipe handoff: closing the
  `BridgeHandoff` closes fd 3.

### Versioning

Each artifact carries `version: 1`. A parser accepts a declared set of
versions; an unknown one is `unsupported_contract`. An incompatible change is a
new integer, never a silent reinterpretation. Optional additions within v1 are
not made: unknown fields are errors, so every addition is a version decision.

## Runtime bundler

`smrt desktop bundle` (the Node-only `@happyvertical/smrt-desktop/bundler`
entry, `runBundle(plan, seams)`) turns a built s-m-r-t app into the runtime half of
a desktop bundle: a pinned Node binary for the Tauri `externalBin`, the
adapter-node build, a pruned production `node_modules`, the MCP bridge, the
two contract manifests above and a provenance report. It does not run the app
build (run `smrt app build` first), does not sign, and does not package; item
4 of epic #4663 (the packaging matrix) consumes its output.

```sh
smrt app build
smrt desktop bundle --app . --out dist/desktop/aarch64-apple-darwin \
  --target aarch64-apple-darwin --bridge dist/smrt-mcp-bridge.mjs
```

`--out` must not exist (or be empty) unless `--force`, and its parent must
exist. `--force` replaces only an empty directory or the output of an earlier
bundle run (the five names below with a `bundle-report.json` that parses); any
other directory, a symlink or a file is refused (`destination_exists`) and left
alone. Everything is built in a staging directory beside `--out` and published
by one `rename`; on any failure the staging directory is removed and `--out`
is untouched. Progress goes to stderr; with `--json` stdout carries only the
canonical report (or a failure document), so it pipes cleanly.

| Flag | Meaning |
| --- | --- |
| `--app <dir>` | application root with `package.json` and `pnpm-lock.yaml` (default `.`); a standalone app, not a workspace member |
| `--build <dir>` | adapter-node output inside `--app` (default `<app>/build`) |
| `--config <file>` | product configuration inside `--app` (default `<app>/smrt-desktop.json`) |
| `--target <triple>` | Rust triple (default: this machine); see Targets |
| `--out <dir>` | output directory (required) |
| `--bridge <file>` | the **pre-bundled** single-file MCP bridge (see Bridge) |
| `--product-id`, `--bundle-id`, `--display-name`, `--product-version`, `--channel` | product identity; flags win over the configuration; the version defaults to the app's `package.json`, the channel to `stable` |
| `--node-version`, `--node-archive`, `--node-cache` | exact pinned Node version (default: newest pinned 26.x), an offline archive (still checked against the pin), the download cache |
| `--features <a,b>` | feature groups to keep in addition to the configuration's defaults |
| `--max-size <MiB>` | installed-size budget; exceeding it exits 6 and publishes nothing, but still prints the report |
| `--measure`, `--measure-data <dir>` | start the bundle on this machine and record installed size and cold start (host target only) |
| `--offline` | `pnpm install --offline` and no Node download (needs the pnpm store and the Node cache) |
| `--keep-sourcemaps`, `--force`, `--json` | keep `*.map`; replace an earlier bundle (or empty directory) at `--out`; JSON on stdout |

### Output

```
<out>/
  binaries/<productId>-node-<triple>[.exe]   Tauri externalBin (tauri-build requires the triple suffix)
  resources/                                 Tauri resource root and the sidecar's working directory
    sidecar-manifest.json                    v1; executable "<productId>-node", args ["app/build/index.js"]
    smrt-bundle.json                         v1 bundle manifest
    app/package.json                         {name, version, private, type: "module"}
    app/build/**                             adapter-node output
    app/node_modules/**                      hoisted production dependencies, pruned
    bridge/smrt-mcp-bridge.mjs               the bridge, byte for byte as supplied
    licenses/node-LICENSE                    Node's LICENSE (macOS and Linux archives)
  tauri.bundle.json                          {"bundle": {"externalBin": ["binaries/<productId>-node"], "resources": {"resources/": "./"}}}
  bundle-files.sha256                        "<sha256>  <path>" for every file under binaries/ and resources/
  bundle-report.json                         provenance and verification record (not a resource)
```

The three top-level files are written after `--measure`'s start, never before:
the started app runs from the bundle and must not be able to change them. The
report records the hash of `tauri.bundle.json` (`files.tauriBundleSha256`), and
a measured start that leaves anything in the output root, or changes a file
under `binaries/` or `resources/`, fails the bundle
(`bundle_changed_while_measuring`).

Merge `tauri.bundle.json` into the Tauri configuration and build with
`tauri build --target <the same triple>`. The sidecar manifest always carries
`NODE_ENV=production`, empty `NODE_OPTIONS` and `NODE_PATH` (the shell passes
the parent environment through) and `SMRT_APP_ID=<productId>`: the app runtime
otherwise reads `package.json` from its working directory, which is the
resource root and holds none. Because the sidecar is named per product, a
`.deb` or `.rpm` never installs `/usr/bin/node`.

### Product configuration (`smrt-desktop.json`)

One strict-JSON file at the app root (closed schema; unknown or repeated keys
and out-of-grammar values are errors, and no error echoes a value):

```json
{
  "version": 1,
  "productId": "smrt-start",
  "bundleId": "com.happyvertical.smrt-start",
  "displayName": "SMRT Start",
  "bridge": { "envPrefix": "SMRT_START", "mcpPath": "/mcp" },
  "sidecar": { "healthRoute": "/api/_runtime/health", "dataDirectory": "runtime" },
  "features": { "default": ["ai-anthropic"], "custom": {} },
  "exclude": [],
  "maxSizeMB": 350,
  "nativeExceptions": [],
  "acknowledgedDynamicImports": [
    { "from": "@happyvertical/ai", "specifier": "openai" },
    { "from": "@happyvertical/ai", "specifier": "@google/genai" },
    { "from": "@happyvertical/sql", "specifier": "@duckdb/node-api" },
    { "from": "@happyvertical/smrt-core", "specifier": "tsx" },
    { "from": "@happyvertical/smrt-core", "specifier": "oxc-transform" }
  ]
}
```

`sidecar.args` (default `["app/build/index.js"]`), `sidecar.ownerClaimRoute`,
`exclude` (extra package patterns to drop), `nativeExceptions`
(`{path, reason}` globs under `app/node_modules`; a matching foreign native is
**deleted**, never shipped, and recorded in the report) and `maxSizeMB` (MiB)
are optional.

### Targets

| Triple | Node distribution | pnpm filter | Native check |
| --- | --- | --- | --- |
| `aarch64-apple-darwin`, `x86_64-apple-darwin` | `node-vX-darwin-{arm64,x64}.tar.gz` | `--os darwin --cpu {arm64,x64}` | Mach-O (thin or fat with the target slice) |
| `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` | `node-vX-linux-{x64,arm64}.tar.gz` | `--os linux --cpu … --libc glibc` | ELF64 LE, machine, glibc (musl is refused) |
| `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` | `win-{x64,arm64}/node.exe` | `--os win32 --cpu …` | PE32+ (`aarch64` is best effort: it works only when every native dependency ships win32-arm64 prebuilds) |

Not supported: musl, `universal-apple-darwin` (Node ships no universal
binary), 32-bit anything. Cross bundling works: the install is
`--frozen-lockfile --prod --ignore-scripts --ignore-pnpmfile` with
`--os/--cpu/--libc`, `--config.node-linker=hoisted` and
`--config.pm-on-fail=ignore`, and natives come from prebuilt optional
packages. No package script, no pnpm hook and no other pnpm version runs on the
build host, and nothing is compiled there; the only code that runs is the host's
own pnpm and, with `--measure`, the bundled app.

### What the install takes from the app

The install runs in a staging directory that gets files from the app, not the
app's directory itself:

- `package.json` without `scripts`, `packageManager` and `devEngines`. The
  last two make pnpm 10 and 11 download and run another pnpm than the host's;
  the report's `host.pnpm` is the version probed from a bare directory, so
  it is the pnpm that really ran, and a differing `packageManager` only warns.
- `pnpm-lock.yaml`, `patches/` and a `pnpm-workspace.yaml`: the app's own
  (verbatim, hash recorded) after the key allowlist below, or a generated
  `packages: []` when the app has none. A workspace file is always present
  because pnpm looks for one in the install directory and then in every parent
  directory; staging sits beside `--out`, normally inside the app and often
  inside a monorepo, so without it an ancestor's `pnpm-workspace.yaml`
  (`overrides`, `catalog`, `pnpmfile`, `configDependencies`) would apply. The
  version probe runs in a sibling directory with the same stop file and a bare
  `package.json`, so an ancestor's `packageManager` cannot switch the probed
  pnpm either. (`--ignore-workspace` is not used: it also stops pnpm reading
  the directory's own `overrides`, `catalog` and `patchedDependencies`, and
  the frozen install then fails with a lockfile config mismatch.) Nothing of an
  ancestor's `package.json` or `.npmrc` reaches the install: the staged
  `package.json` is the nearest project manifest, and only the filtered
  `.npmrc` below is staged.
- `.npmrc` **filtered**: only `registry=`, `@scope:registry=` (an `http(s)` URL
  without credentials and without `${...}`) and the booleans `auto-install-peers`,
  `dedupe-peer-dependents`, `exclude-links-from-lockfile` and
  `strict-peer-dependencies` are staged; the SHA-256 of what was staged is
  `inputs.npmrcSha256`. Every other line is dropped with a count in the
  warnings. **Credentials are not read from the app**: for a private
  registry, put the `_authToken` line (a literal token; a line containing
  `${...}` is dropped, never staged, and the child environment is an
  allowlist) in the build user's own `~/.npmrc`, which pnpm reads.

**Trust model for `pnpm-workspace.yaml`.** The app author supplies this file
and is trusted for dependency resolution only, not for pnpm's own behaviour.
pnpm 10 and 11 honour many more settings from it than the lockfile needs
(`storeDir`, `virtualStoreDir`, `modulesDir`, `lockfileDir`, `cacheDir`,
`stateDir`, `strictSsl`, `registries`, `ca`, `proxy`, ... and the code-loading
`pnpmfile`, `globalPnpmfile`, `configDependencies`), and the command line flags
the bundler passes do not override them. So the file is checked against a
**top-level key allowlist** by a small line scanner (no YAML parser): the
allowed keys are `packages`, `overrides`, `catalog`, `catalogs`,
`patchedDependencies`, `packageExtensions`, `peerDependencyRules`,
`allowedDeprecatedVersions`, `supportedArchitectures`, `onlyBuiltDependencies`, `allowBuilds`,
`neverBuiltDependencies`, `ignoredBuiltDependencies`, `autoInstallPeers`,
`dedupePeerDependents`, `excludeLinksFromLockfile` and
`strictPeerDependencies` (camelCase only; a kebab-case spelling is not on the
list and is refused). Any other key fails the bundle, as does anything that
makes the top-level keys hard to read statically: a second YAML document, a
flow-mapping or sequence root, an indented root, a tab, an anchor, alias, tag or
merge key, a quoted key, a duplicate key, a backslash. The indented content
under an allowed key is not interpreted, except that a non-registry specifier
(`link:`, `file:`, `portal:`, `workspace:`, git or `http(s)://`) under
`overrides`, `catalog` or `catalogs`, and a `..` or absolute path under
`packages` or `patchedDependencies`, are refused.

A `pnpmfile` or `global-pnpmfile` line in `.npmrc`, a `pnpmfile`,
`globalPnpmfile` or `configDependencies` setting under the `pnpm` field of
`package.json`, or any workspace-file problem above fails the bundle before
anything is installed (`unsafe_install_config`, exit 3). The error lists only
setting or key names and fixed labels, never values. `--ignore-pnpmfile` is
passed as well, so a `.pnpmfile.cjs` or a hook in the build user's global pnpm
configuration is not loaded either.

### Features and the size budget

A production closure of a real app is mostly packages a desktop product does
not use. Segmentation **removes** packages, never adds: a package goes when
every path from the app's direct dependencies to it passes through a disabled
root (or an `exclude` entry). The catalog:

| Feature | Removes unless enabled |
| --- | --- |
| `toolchain` (cannot be enabled) | `vite`, `rolldown`, `esbuild`, `lightningcss*`, `typescript`, `tsx`, `oxc-*`, `@oxc-parser/*`, `@oxc-transform/*`, `@oxc-resolver/*`, `@oxc-minify/*`, `@oxc-project/types`, `@types/*`, platform packages of these |
| `google-apis` | `googleapis`, `googleapis-common` |
| `duckdb` | `@duckdb/*` |
| `vector-sqlite` | `sqlite-vss*` |
| `images` | `@happyvertical/images`, `sharp`, `@img/*`, `@resvg/*`, `@mediapipe/*`, `jimp`, `@jimp/*`, `satori` |
| `ai-providers` = `ai-anthropic` + `ai-openai` + `ai-google` | `@anthropic-ai/sdk`, `openai`, `@google/genai` |
| `ocr`, `pdf` | `@happyvertical/ocr`, `tesseract.js*`, `onnxruntime-*`; `@happyvertical/pdf`, `pdfjs-dist` |

`@oxc-project/runtime` is deliberately **not** in the toolchain: compiled s-m-r-t
models import its decorator helpers at run time. A product may add features
under `features.custom`.

Removing a package is only safe if nothing that stays loads it, so the bundler
follows the module graph from the sidecar entry script (relative paths,
package `exports` with the `node`/`import`/`require`/`module-sync`/`default`
conditions and `*` patterns, `main`, `#imports`) and checks every removed
package it meets:

- imported at **load time** (a chain of `import`, `export … from` and top-level
  `require` from the entry): the sidecar would crash at start, so the bundle
  fails (`removed_package_imported`, exit 5), and no setting excuses it;
- imported **lazily** (`import()`, a `require` inside a function, or any file
  only reachable that way, which includes every SvelteKit route module):
  the bundle fails (`dynamic_import_unacknowledged`) until the product lists
  `{from, specifier}` in `acknowledgedDynamicImports`, which the report
  records, so the owner confirms the lazy path is not on the desktop path.

Files that nothing loads (for example `@sveltejs/kit`'s Vite plugin, which
imports `vite`) are not findings. The scan is a heuristic over a hand-written
lexer: it cannot see `import(variable)` (counted as a warning), and the host
start (`--measure`) is the backstop.

File pruning inside kept packages removes `*.map`, `*.d.ts`, `*.ts`, docs
(except `LICENSE*`, `NOTICE*`, `COPYING*`), tests and examples at a package
root unless `main`/`exports`/`bin` points into them, tooling config, static
libraries and prebuilds for other platforms. A secret deny-list (`.env*`,
`.npmrc`, `*.pem`, `*.key`, `.git`, `.smrt`, `*.sqlite*`, …) **fails** the
bundle wherever it matches, and the application build is scanned for private
keys and common token shapes (GitHub, Anthropic, OpenAI `sk-`/`sk-proj-`, Google
`AIza`, npm `npm_`, Stripe `sk_live_`/`rk_live_`, Slack and AWS access keys). The installed size is the sum of every file
under `binaries/` and `resources/`; above 400 MiB without a `maxSizeMB` the
bundler warns.

### Determinism

Identical inputs (lockfile, configuration, Node pin, pnpm version, build tree,
bridge file) give a byte-identical `binaries/`, `resources/`,
`bundle-files.sha256` and `bundle-report.json`. The report has no timestamp or
absolute path; `host` and `measurements` are the only machine-specific
members. Every modification time is `SOURCE_DATE_EPOCH` (default 1980-01-01).
File lists are sorted by UTF-16 code unit order whatever the OS. The report
schema is closed (`parseBundleReport` rejects unknown keys, duplicates,
unsorted lists and bad hashes). The build output itself is only as
deterministic as the app build; its hash is recorded, not rebuilt.

### Exit codes

| Exit | Category | Examples |
| --- | --- | --- |
| 0 | ok | bundle published, every check green |
| 1 | `internal` | a bug; the message never carries a path or a secret |
| 2 | `usage` | bad flag, unsupported target, unpinned Node version, `--measure` for a cross target |
| 3 | `invalid_input` | missing app files, bad configuration, a non-registry dependency, a pnpmfile, config dependency or a `pnpm-workspace.yaml` key outside the allowlist, no `--bridge`, `--out` not empty |
| 4 | `provenance` | Node checksum mismatch, redirect or HTTP error from nodejs.org, lockfile drift, integrity failure |
| 5 | `verification` | wrong-architecture native, symlink, secret, removed package imported, install script without a prebuilt binary, manifests that do not round-trip |
| 6 | `budget` | `--max-size` exceeded |
| 7 | `child_failed` | pnpm failed, the measured start did not answer its health route |
| 8 | `io` | a file operation failed |

`bundleExitCode(error)` is the single mapping; errors carry a closed `code`, a
`stage`, and bundle-relative `subjects`, never an absolute path or file
content.

### Bridge

The bridge must be a single self-contained file that imports only Node
built-ins (`node:` or bare names); the bundler verifies that, hashes it,
copies it unchanged and records its hash. The bundler does not bundle
JavaScript (that would add a runtime dependency to this package), so
`@happyvertical/smrt-app-cli` has to publish the pre-bundled bridge. **That
build is a follow-up** (a second `smrt-app-cli` build output and export
checked by its postbuild); until it lands, produce the file yourself, for
example with `esbuild --bundle --platform=node --format=esm` over
`@happyvertical/smrt-app-cli/dist/bin/smrt-mcp-bridge.js`, as the measured run
below did.

### Threat model and closing tests

| # | Threat | Mitigation | Closing tests |
| --- | --- | --- | --- |
| B1 | Node binary provenance: tampered download, redirect, poisoned cache, wrong version or architecture | committed SHA-256 pins (produced by `scripts/update-node-pins.mjs`), constant HTTPS URL, redirects refused, size caps, hash on every use including cache hits | `rejects a Node archive whose sha256 differs from the pin`; `re-verifies a cached archive and refuses a poisoned cache entry`; `refuses an unpinned Node version before any network or file access`; `refuses any redirect from the dist host`; `aborts a download larger than the cap`; `refuses to run with TLS verification disabled`; `rejects a Node binary built for another architecture` |
| B2 | Archive extraction: tar slip, link members, pax overrides, bombs | one-member reader, output name is ours, header checksums, gzip and member caps | `extracts only the named member and writes nothing else`; `rejects a symlink or hardlink member with the wanted name`; `ignores ../ and absolute member names (they never match)`; `stops a gzip bomb at the expansion cap`; `rejects a header with a bad checksum`; `honours a pax path record for the Node member` |
| B3 | npm integrity, lockfile drift, dependency confusion | `--frozen-lockfile`, only registry specifiers and resolutions, lockfile and manifest hashes recorded, failure output never echoed | `builds the exact pnpm argv for each target`; `rejects link:, file:, git and tarball production dependencies`; `rejects production dependencies that are not registry packages`; `rejects a lockfile package resolved from a tarball URL or git`; `records lockfile and package.json hashes`; `classifies a failed install by its output without echoing it`; `fails when package.json drifts from the lockfile` (opt-in end to end) |
| B4 | Code running on the build host during the install: lifecycle scripts, pnpm hooks, a different pnpm | scripts never run (host or cross), staged manifest has no scripts, `packageManager` or `devEngines`, `--ignore-pnpmfile` and `pm-on-fail=ignore`, `pnpmfile`/`globalPnpmfile`/`configDependencies` and every other `pnpm-workspace.yaml` key outside the allowlist fail the bundle, a workspace file in the install and probe directories stops pnpm reading an ancestor's, only registry lines of `.npmrc` are staged (none with `${...}`), side-effects cache off, install-script packages without a prebuilt binary fail | `never passes a flag that enables scripts for any target`; `never runs scripts: the staged package.json has none and argv is the frozen form`; `always ignores pnpmfile hooks and never lets pnpm switch versions`; `removes packageManager and devEngines so pnpm cannot switch to another version`; `probes the version from a bare directory outside the install directory`; `gives the install and the version probe their own workspace file when the app has none`; `ignores pnpm configuration in an ancestor of --out` (opt-in end to end); `refuses the path, TLS or network key %s and reports only its name`; `fails closed on %s`; `refuses the non-registry specifier %s under overrides and catalogs`; `drops a registry URL that expands an environment variable`; `fails on pnpmfile, global-pnpmfile and config-dependencies keys without echoing values`; `stages only registry and boolean lines of .npmrc and records their hash`; `fails a package with an install script and no prebuilt binary`; `allows the closed list of harmless postinstall packages` |
| B5 | Path traversal and symlink escape while copying | lstat walk, `O_NOFOLLOW` open with identity check, validated segments, `O_EXCL` writes, real containment | `rejects a build directory outside the application`; `rejects a symlink anywhere in the tree without following it`; `rejects FIFOs and, under policy, skips them`; `refuses a file replaced by a different inode between lstat and open`; `refuses a file swapped for a symlink after the walk (O_NOFOLLOW)`; `refuses an ancestor swapped for a symlink during the walk`; `refuses a file opened through a symlinked ancestor even if its identity matches`; `refuses to write through anything already at the destination` |
| B6 | TOCTOU on the output directory, and `--force` deleting something that is not a bundle | private staging next to the output, single `rename`; an existing output must be empty, or with `--force` empty or the output of an earlier bundle run (checked when planning and again on the directory after it is moved aside), and only then is it deleted | `replaces an empty output directory but refuses a non-empty one`; `refuses an output that is a symlink or a file`; `publishes by rename and leaves no staging behind`; `moves a previous bundle aside before deleting it when replacing`; `refuses a directory holding unrelated files and leaves it untouched`; `refuses a bundle layout whose report does not parse, or with extra names`; `refuses a bundle-shaped directory with no report and one whose parts are links`; `refuses a symlink at the output`; `accepts an empty directory and a real earlier bundle`; `checks again after moving the directory aside and puts it back`; `refuses --force on a directory that holds unrelated files`; `refuses a non-empty output directory that appears before publishing`; `removes staging and leaves the output untouched when the build fails` |
| B7 | Wrong-architecture or wrong-libc binaries | header parsers over every file by magic bytes, extension rule, libc from the ELF interpreter and `DT_NEEDED` (musl includes the unversioned `libc.so`; an addon naming no recognised libc and a library outside the glibc-companion list is `unknown` and refused), exceptions delete | `accepts thin arm64 and x86_64 addons (MH_BUNDLE and MH_DYLIB)`; `rejects a fat header whose slice header disagrees`; `rejects a Java class file mistaken for fat Mach-O`; `rejects a musl addon on a gnu target (DT_NEEDED)`; `rejects a musl addon that needs the unversioned libc.so on a gnu target`; `fails closed on an addon whose needed libraries name no recognised libc`; `keeps accepting addons that need only glibc companions or the GCC runtime`; `rejects PE32 (even with an x64 machine) and ARM64EC DLLs`; `rejects a .node file that is not a native binary`; `returns a fixed reason for every prefix of every sample`; `rejects a native binary for another architecture` |
| B8 | A `.node` that is a symlink or shares an inode with the store | links refused in source and output, outputs are fresh copies, natives need `nlink` 1 | `fails symlinks, special files and hardlinked natives`; `refuses hard-linked files by default and copies them as independent files when allowed` |
| B9 | Secrets in the bundle | deny-list fails the bundle, content scan of the build, maps dropped, only registry lines of `.npmrc` reach staging (no credentials) | `fails when the build output contains a .env file`; `fails on a private key in the build output`; `fails on a .smrt data directory inside the build`; `finds the OpenAI, Google, npm and Stripe token shapes and reports only ids`; `does not flag ordinary code or look-alikes`; `never copies the app .npmrc into the output`; `drops source maps unless asked`; `keeps a canary token out of the output, the report and the child environment` |
| B10 | Build-host environment leaking into children | child environment allowlist, forced `npm_config_ignore_scripts`, `NODE_OPTIONS`/`npm_config_*`/`LD_*` dropped | `passes only allowlisted environment names to pnpm`; `drops NODE_OPTIONS and npm_config_* from the child environment`; `forces ignore-scripts in the child environment`; `never leaks a canary token, whatever the variable name` |
| B11 | Environment injection into the sidecar at run time | the manifest empties `NODE_OPTIONS` and `NODE_PATH` | `writes a sidecar manifest that neutralises NODE_OPTIONS and NODE_PATH` |
| B12 | Manifest reproducibility and validity, and a measured app altering the bundle's own metadata | canonical serializers, re-parsed with the contract parsers, byte round trip, cross-check, no timestamps; `tauri.bundle.json` and the file list are written after the measured start and the output root is checked afterwards | `writes manifests the contract parsers accept and that round-trip byte for byte`; `produces identical files and report for identical inputs`; `orders the file list independently of readdir order`; `sets every modification time to the epoch floor or SOURCE_DATE_EPOCH`; `writes tauri.bundle.json and the file list only after the measured start`; `fails when the measured start plants or changes a file in the bundle root` |
| B13 | Bridge not self-contained, swapped or a link | verified regular file, size cap, built-ins only, hash recorded | `rejects a bridge bundle that imports a bare package`; `rejects a bridge that is a symlink`; `records the bridge sha256 and byte count` |
| B14 | A removed package is still needed (availability) | reachability scan, acknowledgements recorded, host start | `fails when the build statically imports a removed package`; `requires acknowledgement for a dynamic import of a removed package`; `ignores a build-time file of a kept package that nothing loads`; `bundles, verifies and measures a fixture app for the host triple` (opt-in end to end) |

The tests live in `src/bundler/*.test.ts`; the end-to-end file is skipped
unless `SMRT_DESKTOP_BUNDLE_E2E=1` (it needs network, pnpm and nodejs.org).

**Residual risks.** The lockfile is trusted reviewed input (a lockfile with
valid integrity for malicious tarballs is out of scope). The Node pins in
`src/bundler/node-pins.ts` were copied from nodejs.org over HTTPS and the
downloaded archive matched them, but **the release signature was not
verified**; run `scripts/update-node-pins.mjs` (needs `gpg`) and review its
diff before shipping. Non-literal `import(x)` is invisible to the scan. The
glibc symbol-version floor of Linux natives is not checked. Windows ACLs of the
output directory are not checked. Windows bundles carry no Node LICENSE file
(the standalone `node.exe` has no archive to take it from). macOS signing and
notarisation of every Mach-O under `resources/` is item 4: `natives[]` in the
report is the list to sign.

### Known gaps found while bundling a real app

- **No first-run schema.** s-m-r-t apps never create tables at run time
  (`smrt db:migrate` does), so a sidecar started on an empty data directory
  exits with `DB_SCHEMA_MISSING`. The desktop shell needs a prepare step
  before the first start, or the runtime needs a supported way to migrate
  itself. `--measure-data` works around it for measurement only: prepare a
  directory with `SMRT_APP_ID=<id> SMRT_DATA_DIR=<dir> smrt app migrate` in
  the app checkout.
- **App identity.** The runtime reads the application id from `package.json`
  in its working directory unless `SMRT_APP_ID` is set; the bundler sets it.
- **Dependency hygiene** drives the size more than any bundler setting; see
  the breakdown below.

### Bundle size and cold start

Measured with `smrt desktop bundle --measure --measure-data <migrated dir>`
on a real app. "Cold start" is the wall time from `spawn()` of the bundled
Node binary (working directory `resources/`, environment from the written
sidecar manifest through `buildSidecarEnv`, a free loopback port) to the first
2xx answer of `GET /api/_runtime/health` (polled every 20 ms, 500 ms per
request, no redirects). Three timed runs per series; the child is stopped
between runs. `firstRun` copies the prepared data directory for every run;
`warm` reuses one directory after an untimed priming start. It is a **new
process, not a cold OS file cache** (dropping caches needs root), and it does
not include schema creation. Compressed installer size is item 4's number.

| Date (UTC) | Product | Target | Node | Machine | Features | Installed (apparent / on disk) | Files | First run median / max | Warm median / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-09 | smrt-start 0.57.2 | aarch64-apple-darwin | 26.8.1 | Apple M4 Max, macOS 26.6.2, pnpm 11.25.0 | `ai-anthropic` | 238.9 MiB / 274.0 MiB | 12 641 | 560.0 / 584.1 ms | 516.6 / 516.7 ms |

Samples (ms): first run 584.1, 560.0, 540.3; warm 516.7, 516.6, 513.1.

Breakdown of the 250 556 856 bytes (238.9 MiB) installed:

| Part | Bytes | MiB |
| --- | --- | --- |
| Node 26.8.1 binary (official darwin-arm64 build) | 145 803 984 | 139.0 |
| `app/node_modules` (386 packages kept, 215 removed) | 91 939 009 | 87.7 |
| `app/build` | 11 178 090 | 10.7 |
| manifests, bridge, licenses, app `package.json` | 1 635 773 | 1.6 |

Segmentation removed 215 packages (663.4 MiB, 11 435 files) and file pruning
another 18 729 files (118.9 MiB). For comparison, the same app with every
enableable feature switched on (only the toolchain removed, files pruned) is
565 538 811 bytes (539.3 MiB, 567 packages, 8 native files besides Node:
DuckDB, sharp, libvips, libsql, resvg and sqlite-vss). The real app does start with the minimal feature set:
`/api/_runtime/health` answers 200 (`status: ready`, `profile: local`), `/setup`
and `/settings` answer 200, `/` redirects (303) and the authenticated routes
answer 401, with nothing on stderr. The Node binary is the largest single
part; the largest kept packages (`du`, on disk) are `@happyvertical/*` (24.0 MiB),
`date-fns` (16.4 MiB), `@libsql` (8.2 MiB), `@modelcontextprotocol` (7.6 MiB)
and `@aws-sdk` (5.4 MiB).

Reproduce: build the app (`pnpm install && pnpm build`), write
`smrt-desktop.json` as above, create the bridge file, prepare the data
directory, then run the `smrt desktop bundle` command with
`--measure --measure-data <dir>` and read `measurements` in
`bundle-report.json`. Per-OS rows from the CI matrix are item 4's.
