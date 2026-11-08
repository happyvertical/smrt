# @happyvertical/smrt-desktop

Versioned JSON contracts for a runtime bundled with an s-m-r-t desktop app.
The runtime bundler writes the sidecar manifest and the desktop supervisor
consumes it before launching the packaged executable. The installed-product
contracts below let other programs on the same machine (an assistant launcher,
a plugin) find and verify that installed app. The package has no runtime
dependencies and uses only Node built-ins.

## Node 26 and adapter-node example

This [manifest](examples/node26-sidecar.json) describes a stock Node 26 sidecar
and a SvelteKit adapter-node build. Mount the app-runtime health handler at
`/api/_runtime/health` and use the local runtime profile.

```json
{
  "version": 1,
  "executable": "node",
  "args": ["build/index.js"],
  "healthRoute": "/api/_runtime/health",
  "dataDirectory": "runtime"
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
  portable segment with no `/`, such as `node`. The launcher owns the
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
   directory, so relative `args` such as `build/index.js` resolve against it.
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
| control channel | desktop shell (server) | `createFileRendezvous`, launcher | `status`, `ensure-ready` (owner-only socket or pipe) |

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
  "node": { "executable": "smrt-start-node" },
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
`node`, as in the Node 26 example above, would install `/usr/bin/node` and
collide with the distribution's own Node. This was reasoned from Tauri's
documented behavior and not verified with a build. The bundle manifest example
therefore uses the product-scoped `smrt-start-node`, and the sidecar manifest
for that product must use the same name. The parser does not forbid `node`;
the choice (and the wording of the Node 26 example) is the owner's decision.

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
between verification and use, only the owner (or root) can alter a path it
accepted.

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
handoff adds a third without changing the codec, because operations are data
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

### Mapping to `LauncherProvider`

<!-- TODO(#4796, contract c): add the credential parts of this mapping
(`acquireCredential` via the control channel and the fd 3 handoff) once the
credential handoff contract is integrated. Only the rendezvous half is
documented here. -->

`connectInstance` maps a `RendezvousResult` from
`createFileRendezvous(...).ensureReady()`:

| Result | `LauncherProvider` outcome |
| --- | --- |
| `ready` | `{ origin }`; keep `instanceNonce` for the credential request |
| `not_installed` | `missing_install` |
| `failed` with `unsupported_contract` | `unsupported_contract` |
| every other `failed`, `not_running`, `untrusted_state`, `timeout` | `stale_instance` |

`unexpected_endpoint` cannot arise from a `ready` result: the origin grammar
(`http://127.0.0.1:<port>`) is enforced by the record and protocol parsers, and
a violation surfaces as `untrusted_state`.

### Versioning

Each artifact carries `version: 1`. A parser accepts a declared set of
versions; an unknown one is `unsupported_contract`. An incompatible change is a
new integer, never a silent reinterpretation. Optional additions within v1 are
not made: unknown fields are errors, so every addition is a version decision.
