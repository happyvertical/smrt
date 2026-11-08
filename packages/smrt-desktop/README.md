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
itself (below). The supervisor rendezvous (`instance.json` and the owner-only
control channel) and the native credential handoff are separate contracts with
their own sections.

| Artifact | Written by | Read by | Contains |
| --- | --- | --- | --- |
| `sidecar-manifest.json` | bundler | supervisor, `locateInstallation` | what to run (see above) |
| `smrt-bundle.json` | bundler | `locateInstallation`, launcher, plugin generator | identity and resource-relative layout |
| `installation.json` | desktop shell, at every start | `locateInstallation` | absolute paths the shell runs from |

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
from a closed union (`InstallErrorCode` for this contract). The `message` is
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

### Versioning

Each artifact carries `version: 1`. A parser accepts a declared set of
versions; an unknown one is `unsupported_contract`. An incompatible change is a
new integer, never a silent reinterpretation. Optional additions within v1 are
not made: unknown fields are errors, so every addition is a version decision.
