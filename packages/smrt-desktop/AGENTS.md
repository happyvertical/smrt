# @happyvertical/smrt-desktop

The sidecar manifest is shared by the desktop runtime bundler and supervisor.
Its v1 wire format (including optional `env` and `ownerClaimRoute`, reserved
supervisor env names, the `buildSidecarEnv` helper, duplicate-key rejection,
the basename `executable`, and the executable/app-root/data-root split),
portable path rules, and trusted package boundary are documented in
[README.md](README.md). Keep the Node 26 example and test cases aligned with
the parser.

The package also publishes the installed-product contracts: the bundle
manifest (`smrt-bundle.json`), the installation record (`installation.json`),
`locateInstallation`, `DesktopContractError` (fixed value-free messages keyed
by a closed code) and `SecretString`. `examples/*.json` are fixtures shared
with the Rust shell's tests: change them only together with the parsers, the
tests and the README. Shared helpers (strict JSON, grammars, absolute paths,
private files) live in `src/internal`; `src/testing` is test-only.

The supervisor rendezvous lives in `src/rendezvous`: the instance record
(`instance.json`), the control-protocol codec, the node:net transport, the
typed failure codes and `createFileRendezvous`, plus an exported reference
server (`startReferenceShell`, `serveControlChannel`) used as a test double.
Clients are read-only: never write, rename or delete a record, socket, lease or
lock, and never retry `failed(lease_held)`. Node cannot verify the control
channel's peer, so the real check lives in the Rust shell; keep that stated.
Control ops are extensible (`ControlOpSpec`, `createControlCodec`, handler
registry); the credential contract adds its op there. Keep the
package free of runtime dependencies and use Node built-ins only.

From this directory, run `npm run build`, `npm run typecheck`, and
`smrt test src`.
