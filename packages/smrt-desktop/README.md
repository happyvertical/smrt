# @happyvertical/smrt-desktop

The versioned sidecar manifest and the runtime bundler for s-m-r-t desktop
apps. The bundler (`smrt desktop bundle`) writes the sidecar manifest; the Tauri
wrapper (`wrapper/`) reads it before launching the packaged executable. The
package has no runtime dependencies and uses only Node built-ins.

Owner sign-in is app-runtime's loopback onboarding URL and `claimOwner()`, and
local MCP credentials are app-runtime's token store (`openLocalMcpTokenStore`);
this package does not duplicate either.

## Node 26 and adapter-node example

This [manifest](examples/node26-sidecar.json) describes a stock Node 26 sidecar
and a SvelteKit adapter-node build, in the layout `smrt desktop bundle` writes:
the sidecar is product-scoped (`<productId>-node`, never a bare `node`), the
app sits under `app/` in the resource directory, and `env` empties the
`NODE_OPTIONS` and `NODE_PATH` the wrapper would otherwise inherit from the
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
- `dataDirectory` is a portable path relative to Tauri's stable
  `app_local_data_dir` (the per-app, machine-local OS data root; see
  [Data root and roaming](#data-root-and-roaming)). The supervisor supplies its
  resolved absolute path to the local runtime as `SMRT_DATA_DIR`. The
  app-runtime retains ownership of directory custody.
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
3. Data root: `dataDirectory` resolves under `app_local_data_dir`, outside the
   app root, so app updates never touch runtime data.

#### Data root and roaming

> **Assumed decision D7, pending owner confirmation.** The wrapper resolves the
> sidecar data directory (`SMRT_DATA_DIR`) and its own log
> (`<app_local_data_dir>/.desktop-wrapper/supervisor.log`) under Tauri's
> `app_local_data_dir` on every platform, the same root the installed-product
> contracts already use for private state. Alternative: keep Tauri's
> `app_data_dir`, which on Windows is the roaming `%APPDATA%` profile.

Reason: the runtime keeps SQLite files, a writer lease and process state in the
data directory, and none of that may follow a user to another machine through a
roaming profile. On macOS (`~/Library/Application Support/<identifier>`) and
Linux (`${XDG_DATA_HOME:-~/.local/share}/<identifier>`) the local and roaming
roots are the same directory, so nothing moves there. Only Windows changes:
`%APPDATA%\<identifier>` becomes `%LOCALAPPDATA%\<identifier>`. No released
product exists yet, so there is no migration; a build that ran before this
change on Windows leaves its old directory behind in the roaming profile.

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

## Versioning

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
| `--require-verified-pins` | the release and signing path: refuse a Node pin whose provenance is not `gpg-verified` (`node_pin_unverified`, exit 4) before any work; without it an unverified pin only warns (see Node pin provenance) |
| `--features <a,b>` | feature groups to keep in addition to the configuration's defaults |
| `--max-size <MiB>` | installed-size budget; exceeding it exits 6 and publishes nothing, but still prints the report |
| `--measure`, `--measure-data <dir>` | start the bundle on this machine and record installed size and cold start (host target only); this **runs the app's dependency code**, see Measuring runs the app |
| `--offline` | `pnpm install --offline` and no Node download (needs the pnpm store and the Node cache) |
| `--keep-sourcemaps`, `--force`, `--json` | keep `*.map`; replace an earlier bundle (or empty directory) at `--out`; JSON on stdout |

### Measuring runs the app

Everything the bundler does on the build host is inert (nothing is compiled
and no package script runs) **except `--measure`, which starts the bundled
sidecar**: the app's own code and every dependency it loads run as the build
user, with the build host's network and `HOME` (and the other location
variables of the child environment allowlist: `USERPROFILE`, `APPDATA`,
`XDG_*`, temp directories, and the proxy variables, which may embed
credentials) passed through, so the app can read what that user can read,
including `~/.npmrc`. `NODE_OPTIONS`, `NODE_PATH` and every other variable are
not passed. Only measure bundles of apps and locks you would run
anyway, preferably in a disposable build environment, and never measure a
bundle whose dependencies you have not reviewed.

Stopping the measured process is part of the guarantee that the bundle is
unchanged when it is signed. On POSIX the sidecar is started as a **process
group leader**; stopping it sends SIGTERM to the whole group and to every
descendant seen in the process table (including one started `detached`, which
is in another group), waits, then SIGKILLs what is left, and the bundle fails
(`measured_process_survived`, exit 5) if any process of the group or tree is
still running. The digests of `binaries/` and `resources/` are checked after
that. Because the sidecar leads its own session, Ctrl+C or SIGTERM of the CLI
does not reach it: while a measured child runs, the bundler also handles
`exit`, `SIGINT` and `SIGTERM` by SIGKILLing its group and descendants
synchronously, then exits `128 + signal` as before (the handlers are removed
once the child is stopped). Only SIGKILL of the CLI itself cannot be handled. Limits: a process that double-forks away and leaves the group is not
found; and **on Windows only the direct child is stopped and nothing is
verified** (a job object is a tracked follow-up), so do not measure untrusted
apps on Windows. The cross-target case is not measurable at all.

### Node pin provenance

The Node binary is trusted through the SHA-256 pins in
`src/bundler/node-pins.ts`. Each pinned version also has a provenance record:
`verification` (`gpg-verified` or `unverified`), the `SHASUMS256.txt` URL, the
retrieval time, the SHA-256 of the `SHASUMS256.txt` the hashes came from and,
for a verified pin, the primary-key fingerprints that signed it. Only
`scripts/update-node-pins.mjs`, run by a maintainer with `gpg` and the public
Node.js release keys from `https://github.com/nodejs/release-keys`, can write
`gpg-verified`; the header of the script lists the exact commands. A record
that says `gpg-verified` without fingerprints or digest counts as unverified,
and the repository tests fail on it.

**Status: the only pin, Node 26.8.1, is `unverified`.** It was copied from the
TLS-served `SHASUMS256.txt` on a machine without `gpg`, so the signature check
is blocked until a maintainer runs the script where `gpg` exists. Until then:

- every bundle records the provenance it used in `bundle-report.json`
  (`node.pin`: `verification`, `source`, `retrieved`, `shasumsSha256`,
  `signerFingerprints`), and an unverified pin adds a `WARNING:` line to the
  warnings the CLI prints on stderr (and returns in `BundleResult.warnings`);
- `--require-verified-pins` (`requireVerifiedPins` in the API) refuses an
  unverified pin before any work: `node_pin_unverified`, exit 4. Use it for
  every bundle that will be released or signed. Packaging and signing (item 4)
  can also call `assertVerifiedNodePin(report)` on an existing report.

### Output

```
<out>/
  binaries/<productId>-node-<triple>[.exe]   Tauri externalBin (tauri-build requires the triple suffix)
  resources/                                 Tauri resource root and the sidecar's working directory
    sidecar-manifest.json                    v1; executable "<productId>-node", args ["app/build/index.js"]
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
`NODE_ENV=production`, empty `NODE_OPTIONS` and `NODE_PATH` (the wrapper passes
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

`sidecar.args` (default `["app/build/index.js"]`; see below), `sidecar.ownerClaimRoute`,
`exclude` (extra package patterns to drop), `nativeExceptions`
(`{path, reason}` globs under `app/node_modules`; a matching foreign native is
**deleted**, never shipped, and recorded in the report) and `maxSizeMB` (MiB)
are optional.

`sidecar.args` is what the wrapper passes to the bundled Node binary, so it ships
to every end user. Node flags are an **allowlist**, not a denylist (Node has too
many options that load code or change trust, such as `--conditions`/`-C`,
`--security-revert`, `--insecure-http-parser`, `--experimental-config-file` and
`--env-file-if-exists`, and a release adds more): the only flag accepted is
`--max-old-space-size=<MiB>` (10 to 999999, spelled exactly like that, at most
once, before the script), the V8 heap ceiling. Anything else beginning with `-`
(including abbreviations, the `--flag value` form, `-C`, `--` and
`--node-options=...`) fails with `config_invalid_field`. The first argument that
is not a flag is the entry script (a portable relative path ending in `.js`,
`.mjs` or `.cjs`); after it come only plain values (portable paths or digits)
for the script, never flags. To allow another Node flag, add it to
`SIDECAR_NODE_FLAG_ALLOWLIST` with a reason. This guards the product
configuration; the sidecar manifest parser the wrapper uses accepts any valid
text arguments, so the wrapper must treat `sidecar-manifest.json` as trusted
build output.

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
- `.npmrc` **filtered**: only `registry=`, `@scope:registry=` (an `https` URL
  without credentials and without `${...}`; plain `http` is accepted only for
  `localhost`, `127.0.0.1` and `[::1]`, and a plain-http registry on any other
  host fails the bundle with `unsafe_install_config`) and the booleans `auto-install-peers`,
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

The same walk also checks that the files the sidecar loads are still there.
A **relative** import (`./x.js`, `../lib`) whose target does not exist in the
pruned bundle, whether pruning removed it or the package never shipped it,
fails the bundle (`relative_import_missing`, exit 5), in the application build
as well as in kept packages. It has the same two tiers: a load-time one is a
crash at start, and a lazy one (or one the lexer cannot tell from a guarded
`try { require('./x') } catch {}`) can be listed in
`acknowledgedDynamicImports` with its `{from, specifier}`, which the report
records. A relative `.node` specifier is left to the native check. A bare
import that resolves to nothing installed (typically an optional dependency)
is not a failure; it is counted in the report (`importScan.unresolvedBareImports`,
with `filesReached`, `loadTimeFiles`, `nonLiteralImports` and `unscannedFiles`)
and adds one warning.

Files that nothing loads (for example `@sveltejs/kit`'s Vite plugin, which
imports `vite`) are not findings. The scan is a heuristic over a hand-written
lexer: it cannot see `import(variable)` (counted in
`importScan.nonLiteralImports` and as a warning), `readFileSync` of a computed
path, or an import of a package that is only reached that way.

**A bundle built without `--measure` has no runtime check.** Nothing starts the
sidecar: the scan above is static, and only a start on this machine (host
target only) shows that the bundle really runs. Cross-target bundles can never
be measured here, so run the product's own smoke test on the target before you
ship one. Even with `--measure`, only the health route is exercised, not every
route or feature.

File pruning inside kept packages removes `*.map`, `*.d.ts`, `*.ts`, docs
(except `LICENSE*`, `NOTICE*`, `COPYING*`), tests and examples at a package
root unless `main`/`exports`/`bin` points into them, tooling config, static
libraries and prebuilds for other platforms. Pruning never removes a file that
a reached module refers to: before pruning, the same walk runs over the
unpruned install tree and the targets of relative imports of any kind, plus
literal `new URL('./x', import.meta.url)`, `join(__dirname, 'a', 'b')` and
`readFileSync('./x')` paths that exist, are kept together with the directories
that hold them (a removed package or a foreign-platform native directory is
still removed). A reference to a **directory** keeps that directory and those
on the way, not what is inside it: `resolve(__dirname, '..')`,
`new URL('./', import.meta.url)` or `readdirSync('./')` name a package root, and
its tests, docs, types and fixtures (a fixture `key.pem` included) are still
pruned. Only an explicit asset directory, a literal ending in `/` that names a
directory (`new URL('./assets/', import.meta.url)`), keeps its whole contents.
Paths built at run time are invisible to this. A secret deny-list (`.env*`,
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
| 4 | `provenance` | Node checksum mismatch, redirect or HTTP error from nodejs.org, lockfile drift, integrity failure, an unverified Node pin under `--require-verified-pins` |
| 5 | `verification` | wrong-architecture native, symlink, secret, removed package imported, a process left running after `--measure`, a relative import whose target is not in the bundle, install script, `gypfile` or `binding.gyp` without a prebuilt addon for the target, manifests that do not round-trip |
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
| B1 | Node binary provenance: tampered download, redirect, poisoned cache, wrong version or architecture, a pin that was never checked against the release signature | committed SHA-256 pins (produced by `scripts/update-node-pins.mjs`), constant HTTPS URL, redirects refused, size caps, hash on every use including cache hits; per-pin provenance recorded in the report, a loud warning for an unverified pin and a hard refusal under `--require-verified-pins` | `fails the suite when a pin says gpg-verified without its evidence`; `keeps the unverified pins to the one known, tracked entry`; `refuses the release and signing path while the pin is unverified, before any work`; `refuses a pin that claims gpg verification without its evidence`; `records the provenance of the pin it used and warns loudly while that pin is unverified`; `rejects a Node archive whose sha256 differs from the pin`; `re-verifies a cached archive and refuses a poisoned cache entry`; `refuses an unpinned Node version before any network or file access`; `refuses any redirect from the dist host`; `aborts a download larger than the cap`; `refuses to run with TLS verification disabled`; `rejects a Node binary built for another architecture` |
| B2 | Archive extraction: tar slip, link members, pax overrides, bombs | one-member reader, output name is ours, header checksums, gzip and member caps | `extracts only the named member and writes nothing else`; `rejects a symlink or hardlink member with the wanted name`; `ignores ../ and absolute member names (they never match)`; `stops a gzip bomb at the expansion cap`; `rejects a header with a bad checksum`; `honours a pax path record for the Node member` |
| B3 | npm integrity, lockfile drift, dependency confusion | `--frozen-lockfile`, only registry specifiers and resolutions, lockfile and manifest hashes recorded, failure output never echoed | `builds the exact pnpm argv for each target`; `rejects link:, file:, git and tarball production dependencies`; `rejects production dependencies that are not registry packages`; `rejects a lockfile package resolved from a tarball URL or git`; `records lockfile and package.json hashes`; `classifies a failed install by its output without echoing it`; `fails when package.json drifts from the lockfile` (opt-in end to end) |
| B4 | Code running on the build host during the install: lifecycle scripts, pnpm hooks, a different pnpm | scripts never run (host or cross), staged manifest has no scripts, `packageManager` or `devEngines`, `--ignore-pnpmfile` and `pm-on-fail=ignore`, `pnpmfile`/`globalPnpmfile`/`configDependencies` and every other `pnpm-workspace.yaml` key outside the allowlist fail the bundle, a workspace file in the install and probe directories stops pnpm reading an ancestor's, only registry lines of `.npmrc` are staged (none with `${...}`), side-effects cache off, install-script, `gypfile` and root `binding.gyp` packages without a prebuilt addon for the target fail (the addon is looked for in what survives pruning, so one for another platform does not count) | `never passes a flag that enables scripts for any target`; `never runs scripts: the staged package.json has none and argv is the frozen form`; `always ignores pnpmfile hooks and never lets pnpm switch versions`; `removes packageManager and devEngines so pnpm cannot switch to another version`; `probes the version from a bare directory outside the install directory`; `gives the install and the version probe their own workspace file when the app has none`; `ignores pnpm configuration in an ancestor of --out` (opt-in end to end); `refuses the path, TLS or network key %s and reports only its name`; `fails closed on %s`; `refuses the non-registry specifier %s under overrides and catalogs`; `drops a registry URL that expands an environment variable`; `fails on pnpmfile, global-pnpmfile and config-dependencies keys without echoing values`; `stages only registry and boolean lines of .npmrc and records their hash`; `fails on a registry that is plain http to a remote host, without echoing the URL`; `accepts https registries and plain http only for a loopback host`; `fails a package with an install script and no prebuilt binary`; `fails a package whose only addon is for another platform (checked after pruning)`; `accepts a package whose prebuilds include the target next to foreign ones`; `fails a package that builds only from a root binding.gyp`; `accepts a binding.gyp package that ships a prebuilt addon for the target, and ignores one in a removed package`; `allows the closed list of harmless postinstall packages` |
| B5 | Path traversal and symlink escape while copying | lstat walk, `O_NOFOLLOW` open with identity check, validated segments, `O_EXCL` writes, real containment | `rejects a build directory outside the application`; `rejects a symlink anywhere in the tree without following it`; `rejects FIFOs and, under policy, skips them`; `refuses a file replaced by a different inode between lstat and open`; `refuses a file swapped for a symlink after the walk (O_NOFOLLOW)`; `refuses an ancestor swapped for a symlink during the walk`; `refuses a file opened through a symlinked ancestor even if its identity matches`; `refuses to write through anything already at the destination` |
| B6 | TOCTOU on the output directory, and `--force` deleting something that is not a bundle | private staging next to the output, single `rename`; an existing output must be empty, or with `--force` empty or the output of an earlier bundle run (checked when planning and again on the directory after it is moved aside), and only then is it deleted | `replaces an empty output directory but refuses a non-empty one`; `refuses an output that is a symlink or a file`; `publishes by rename and leaves no staging behind`; `moves a previous bundle aside before deleting it when replacing`; `refuses a directory holding unrelated files and leaves it untouched`; `refuses a bundle layout whose report does not parse, or with extra names`; `refuses a bundle-shaped directory with no report and one whose parts are links`; `refuses a symlink at the output`; `accepts an empty directory and a real earlier bundle`; `checks again after moving the directory aside and puts it back`; `refuses --force on a directory that holds unrelated files`; `refuses a non-empty output directory that appears before publishing`; `removes staging and leaves the output untouched when the build fails` |
| B7 | Wrong-architecture or wrong-libc binaries | header parsers over every file by magic bytes, extension rule, libc from the ELF interpreter and `DT_NEEDED` (musl includes the unversioned `libc.so`; an addon naming no recognised libc and a library outside the glibc-companion list is `unknown` and refused), exceptions delete | `accepts thin arm64 and x86_64 addons (MH_BUNDLE and MH_DYLIB)`; `rejects a fat header whose slice header disagrees`; `rejects a Java class file mistaken for fat Mach-O`; `rejects a musl addon on a gnu target (DT_NEEDED)`; `rejects a musl addon that needs the unversioned libc.so on a gnu target`; `fails closed on an addon whose needed libraries name no recognised libc`; `keeps accepting addons that need only glibc companions or the GCC runtime`; `rejects PE32 (even with an x64 machine) and ARM64EC DLLs`; `rejects a .node file that is not a native binary`; `returns a fixed reason for every prefix of every sample`; `rejects a native binary for another architecture` |
| B8 | A `.node` that is a symlink or shares an inode with the store | links refused in source and output, outputs are fresh copies, natives need `nlink` 1 | `fails symlinks, special files and hardlinked natives`; `refuses hard-linked files by default and copies them as independent files when allowed` |
| B9 | Secrets in the bundle | deny-list fails the bundle, content scan of the build, maps dropped, only registry lines of `.npmrc` reach staging (no credentials) | `fails when the build output contains a .env file`; `fails on a private key in the build output`; `fails on a .smrt data directory inside the build`; `finds the OpenAI, Google, npm and Stripe token shapes and reports only ids`; `does not flag ordinary code or look-alikes`; `never copies the app .npmrc into the output`; `drops source maps unless asked`; `keeps a canary token out of the output, the report and the child environment` |
| B10 | Build-host environment leaking into children | child environment allowlist, forced `npm_config_ignore_scripts`, `NODE_OPTIONS`/`npm_config_*`/`LD_*` dropped | `passes only allowlisted environment names to pnpm`; `drops NODE_OPTIONS and npm_config_* from the child environment`; `forces ignore-scripts in the child environment`; `never leaks a canary token, whatever the variable name` |
| B11 | Environment and option injection into the sidecar at run time | the manifest empties `NODE_OPTIONS` and `NODE_PATH`; the product configuration may pass Node only the allowlisted `--max-old-space-size=<n>`, before a script that must be `.js`, `.mjs` or `.cjs` | `writes a sidecar manifest that neutralises NODE_OPTIONS and NODE_PATH`; `documents the one flag a product may set, exactly and only before the script`; `rejects NODE_OPTIONS-style smuggling through the arguments`; `rejects the -- terminator wherever it stands`; `needs a script, and no argument may be empty or non-text` |
| B12 | Manifest reproducibility and validity, and a measured app altering the bundle's own metadata | canonical serializers, re-parsed with the contract parsers, byte round trip, cross-check, no timestamps; `tauri.bundle.json` and the file list are written after the measured start and the output root is checked afterwards; the measured process group and its descendants are stopped and verified gone before the digests are re-checked (POSIX) | `writes manifests the contract parsers accept and that round-trip byte for byte`; `produces identical files and report for identical inputs`; `orders the file list independently of readdir order`; `sets every modification time to the epoch floor or SOURCE_DATE_EPOCH`; `writes tauri.bundle.json and the file list only after the measured start`; `fails when the measured start plants or changes a file in the bundle root`; `does not take the exit of the child for the end of its group`; `fails the bundle when a process is still running after SIGKILL`; `leaves no grandchild running, grouped or detached`; `leaves no grandchild running even when everything ignores SIGTERM`; `kills the sidecar, its group and a detached grandchild on %s, and the CLI still exits %i` |
| B13 | Bridge not self-contained, swapped or a link | verified regular file, size cap, built-ins only, hash recorded | `rejects a bridge bundle that imports a bare package`; `rejects a bridge that is a symlink`; `records the bridge sha256 and byte count` |
| B14 | A removed package, or a file pruning removed, is still needed (availability) | reachability scan, relative imports checked against the pruned tree, files reached modules refer to protected from pruning, acknowledgements recorded, host start (a bundle built without `--measure` has no runtime check) | `fails when a reached file imports a relative path that is not in the bundle`; `fails on a missing relative import in the application build, and lets a lazy one be acknowledged`; `keeps a file a reached module imports from a directory that pruning removes by name`; `keeps data files a reached module reads by a literal path, and still prunes docs nobody names`; `does not let a reference to a package root keep its tests, docs and fixtures, so a fixture key is pruned instead of failing the bundle`; `keeps everything under an explicit asset directory a reached module names`; `records what the import scan covered, including bare imports that resolved to nothing`; `fails when the build statically imports a removed package`; `requires acknowledgement for a dynamic import of a removed package`; `ignores a build-time file of a kept package that nothing loads`; `bundles, verifies and measures a fixture app for the host triple` (opt-in end to end) |

The tests live in `src/bundler/*.test.ts`; the end-to-end file is skipped
unless `SMRT_DESKTOP_BUNDLE_E2E=1` (it needs network, pnpm and nodejs.org).

**Residual risks.** The lockfile is trusted reviewed input (a lockfile with
valid integrity for malicious tarballs is out of scope). The Node pins in
`src/bundler/node-pins.ts` were copied from nodejs.org over HTTPS and the
downloaded archive matched them, but **the release signature has not been
verified** (blocked on a machine with `gpg`; the pin's provenance says
`unverified`, the report records that, and `--require-verified-pins` refuses
it): run `scripts/update-node-pins.mjs` with `gpg` and review its diff before
shipping. Non-literal `import(x)` is invisible to the scan. The
glibc symbol-version floor of Linux natives is not checked. Windows ACLs of the
output directory are not checked. Windows bundles carry no Node LICENSE file
(the standalone `node.exe` has no archive to take it from). macOS signing and
notarisation of every Mach-O under `resources/` is item 4: `natives[]` in the
report is the list to sign.

### Known gaps found while bundling a real app

- **No first-run schema.** s-m-r-t apps never create tables at run time
  (`smrt db:migrate` does), so a sidecar started on an empty data directory
  exits with `DB_SCHEMA_MISSING`. The desktop wrapper needs a prepare step
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
