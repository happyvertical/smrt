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
  "executable": "binaries/node",
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

- `version` is the number `1`. All five fields are required. Unknown fields and
  versions are errors. A future incompatible contract requires a new version.
- `executable` is a portable path relative to the packaged executable root.
  For Tauri `externalBin` it is the configured logical path before any
  target-specific suffix or extension. The supervisor uses its packaged
  executable mapping and never searches `PATH`.
- `args` is an ordered array of literal strings. Empty arrays and empty strings
  are valid. NUL and unpaired UTF-16 surrogates are rejected. The supervisor
  passes the array directly as process arguments, with the packaged app root
  as its working directory. The argument strings receive no shell expansion,
  token substitution, or path rewriting. Their interpretation belongs to the
  chosen executable.
- `healthRoute` is a path on the supervisor-selected loopback origin.
  It begins with one slash and can be `/` or have nonempty segments containing
  only ASCII letters, digits, periods, underscores, tildes, and hyphens.
  A trailing slash is allowed. Dot segments, URL origins, network-path
  references, backslashes, percent escapes, queries and fragments are invalid.
  The probe stays on the selected loopback origin and rejects redirects.
- `dataDirectory` is a portable path relative to the per-app OS data root.
  The supervisor supplies its resolved absolute path to the local runtime as
  `SMRT_DATA_DIR`. The app-runtime retains ownership of directory custody.

Portable paths use forward-slash-separated nonempty segments, each starting
with an ASCII letter, digit, underscore or hyphen. Subsequent characters may
also include periods. Trailing periods and Windows device names (`CON`, `PRN`,
`AUX`, `NUL`, `COM0` through `COM9`, and `LPT0` through `LPT9`, including
extension forms) are rejected. The same lexical rules apply on each target.

The parser throws a fixed diagnostic on malformed JSON or invalid fields and
returns a typed snapshot on success. The bundler serializes that snapshot to
write the artifact, so consumers receive one occurrence of each field. The
manifest is trusted package content.
The bundler and supervisor enforce executable provenance and filesystem
containment, including symlink handling. Argument policies belong to the
packaging tool and runtime being launched.
