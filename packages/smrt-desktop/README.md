# @happyvertical/smrt-desktop

Versioned JSON manifest for a runtime bundled with an s-m-r-t desktop app. The
runtime bundler writes the manifest and the desktop supervisor consumes it
before launching the packaged executable.

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
