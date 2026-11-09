# @happyvertical/smrt-desktop-launcher

The core of the node-less launcher from #4729 (epic #4669). A Claude Desktop or
ChatGPT desktop plugin starts a small native executable; that executable runs
`runLauncher()` with a provider supplied by the desktop shell. The launcher
checks the bundled runtime, confirms the local instance and credential, starts
the bundled `smrt-mcp-bridge` on the product's own Node, and forwards stdio
until either side goes away.

It does not find installed products, start the desktop app or keep a
credential. The desktop supervisor, runtime bundler and credential custody
from #4663 supply those through the provider. Native executable packaging is
also separate.

```ts
import { runLauncher } from '@happyvertical/smrt-desktop-launcher';

process.exitCode = await runLauncher({
  provider, // the shell's LauncherProvider
  productId: 'hearthos', // baked in when the plugin is generated
});
```

Set `process.exitCode` and let the event loop drain; do not call
`process.exit()` before stdout and stderr have flushed.

## Provider interface

`LauncherProvider` has three methods. Each receives an `AbortSignal` that is
aborted on shutdown or when the method exceeds `providerTimeoutMs` (default
30 s). Each either resolves or rejects with `LauncherProviderError(code)`. Any
other rejection is an `internal` error, and provider messages are never
printed.

| Method | Responsibility | Failure codes |
| --- | --- | --- |
| `resolveInstall({ productId })` | Return the installed product: `contract` (currently `1`), `productId`, trusted `root`, absolute `nodePath` and `bridgePath` inside it, `healthRoute`, bridge `envPrefix`, optional `mcpPath`, `serverName`, `serverVersion`. | `missing_install`, `unsupported_contract` |
| `connectInstance(install)` | Find or start the supervisor-owned instance and return its current loopback `origin`. | `stale_instance`, `unexpected_endpoint` |
| `acquireCredential(install, instance)` | Hand over the owner-issued bearer as `{ token, release? }`. The token uses only `A-Z a-z 0-9 . _ ~ -`, which holds for local MCP tokens. `release` runs at most once: as soon as the bridge has started, or when the launch fails or is abandoned (including a credential that arrives after a timeout or signal). | `credential_unavailable`, `credential_invalid` |

### Mapping onto wave 1 (#4663)

Wave 1 states on #4663 which published interface satisfies each method. The
expected correspondence, from #4729:

| Method | Expected wave 1 source |
| --- | --- |
| `resolveInstall` | Runtime bundler: installed product identity and trusted absolute Node and bridge entry paths. The v1 sidecar manifest (`@happyvertical/smrt-desktop`) supplies `healthRoute`. |
| `connectInstance` | Supervisor: owner-only start-or-reuse rendezvous reporting the ready instance's current loopback origin. |
| `acquireCredential` | Desktop credential custody and handoff over the local credential lifecycle (`@happyvertical/smrt-app-runtime`, `POST /api/local/mcp-credentials`, #4726). |

A shell can adapt a differently shaped interface inside its provider; nothing
else in the launcher changes. If a published interface cannot express a
method, say so on #4663 rather than widening this interface.

## Launch sequence

1. `resolveInstall`. Check the contract version and field shapes, and that the
   product is the one the launcher was built for.
2. Verify the files (below). Nothing is executed yet.
3. `connectInstance`. The origin must be exactly
   `http://127.0.0.1:<port>`, `http://[::1]:<port>` or
   `http://localhost:<port>`: no HTTPS, userinfo, path, query or fragment.
4. `GET <origin><healthRoute>` must answer 2xx. Redirects are refused.
5. `acquireCredential`. The credential is requested only now, so a bad
   install or the wrong endpoint never causes a handoff.
6. An authenticated JSON-RPC `ping` to the MCP endpoint. 401 or 403 means the
   credential is invalid or revoked; 404 or 405 means the wrong endpoint; 5xx
   or no answer means a stale instance.
7. Verify the files again, then spawn the bridge.

Every network probe has a timeout (`probeTimeoutMs`, default 5 s).

## Trust checks

- `nodePath`, `bridgePath` and `root` are absolute and already normalised (no
  `..`, `.`, empty segments or NUL). A bare name such as `node` is rejected;
  `PATH` is never consulted and no shell is used.
- Both files lie strictly inside `root` and are reached without a symlink
  anywhere below it.
- On POSIX, every directory from `root` down and both files are owned by the
  current user or root and are not writable by group or others. The Node file
  is executable; the bridge is readable. On Windows the bundler's install
  location and ACLs are the boundary.
- The provider's answer is copied before it is checked, so the provider
  cannot change it afterwards.

The launcher runs the canonical, symlink-free paths it verified, with `root`
as the working directory, so repointing a symlinked `root` after the final
check does not change what runs.

A same-user process can still swap a file between the final check and the
spawn. That user can already read the credential, so the check protects
against other users and mis-resolved paths, not a hostile process running as
the same user.

## What the endpoint checks do not prove

Loopback and a 2xx health route show that something local answered, not that
it is the product's own instance. Another local user who takes over a stale
rendezvous port could answer the probes and then receive the credential. The
supervisor's owner-only rendezvous is the identity boundary: `connectInstance`
must only report an origin the supervisor itself started or verified. The
launcher does not add an instance nonce; if wave 1 publishes one, the health
probe is the place to check it.

## The bridge process

The launcher runs `<nodePath> <bridgePath> --env-prefix=<PREFIX>
--mcp-path=<path> [--name=… --version=…]` with `cwd` set to `root`, no shell,
and an environment built from scratch:

- `<PREFIX>_SERVER_URL`: the validated origin.
- `<PREFIX>_TOKEN`: the credential.
- `<PREFIX>_CLI_CONFIG`: the null device, so the bridge reads no ambient
  config file.

Nothing else is inherited: no `PATH`, `NODE_OPTIONS`, proxy settings or
unrelated secrets. This is the configuration the existing `smrt-mcp-bridge`
reads. The credential is therefore in the bridge's environment, readable by
the same user and by no one else on a normal system. A descriptor-based handoff
would need a bridge change and is not part of this slice.

## Diagnostics and exit codes

Failures write one line to stderr, `smrt-desktop-launcher: <code>: <fixed
text>`, and exit with a stable code. The text is constant: no path, origin,
credential, provider message or child output is interpolated. The launcher
writes nothing else to stdout or stderr itself.

| Exit | Code | Meaning |
| --- | --- | --- |
| 0 | | The host closed stdin, or the bridge exited cleanly. |
| 10 | `missing_install` | No installed product, or a different product. |
| 11 | `unsupported_contract` | Unknown contract version or malformed install. |
| 12 | `stale_instance` | The instance is gone, unhealthy or did not answer in time. |
| 13 | `credential_unavailable` | Custody holds no credential. |
| 14 | `credential_invalid` | Rejected, revoked, expired, mismatched or malformed credential. |
| 15 | `unexpected_endpoint` | Not a loopback origin, or not this product's MCP route. |
| 16 | `untrusted_runtime` | A path or file failed the trust checks. |
| 17 | `bridge_start_failed` | The bridge process could not be started. |
| 18 | `bridge_exited` | The bridge exited non-zero or was killed. |
| 20 | `internal` | Unexpected failure. |
| 128+n | | Shutdown by `SIGHUP` (129), `SIGINT` (130) or `SIGTERM` (143). |

## Stdio lifecycle

- Host stdin is piped to the bridge and the bridge's stdout and stderr to the
  host. Stream pipes provide backpressure in both directions.
- Host stdin closing ends the bridge's stdin. The bridge is given
  `shutdownGraceMs` (default 5 s) to exit, then receives `SIGTERM`, then
  `SIGKILL`. The launcher exits 0.
- `SIGTERM`, `SIGINT` and `SIGHUP` stop forwarding, signal the bridge with the
  same escalation, wait for it, and exit `128 + n`. A second signal kills the
  bridge immediately. A signal during startup abandons the provider call and
  starts no child.
- If the bridge dies, forwarding stops and the launcher exits (0 or 18). If the
  host stops reading stdout, the bridge is stopped.
- The bridge always has a pipe to the launcher, so if the launcher is killed
  outright the bridge sees end of input and exits by itself.
- The launcher waits for the bridge's output to flush. `outputFlushTimeoutMs`
  (default 2 s) bounds that wait: pipes held open by stray grandchildren are
  cut, and output a stalled host never read is dropped. A second signal skips
  the wait.

## Credential redaction

The credential is held in memory only. It never appears in argv, a file, a
URL or a launcher diagnostic. Bridge stdout and stderr pass through a
streaming filter that replaces the exact credential with `[REDACTED]`, even
when split across chunks. It holds back only a trailing partial match, so
ordinary output is not delayed; a stream that ends inside such a match
(four or more bytes of the credential) emits `[REDACTED]` rather than a
prefix. The credential alphabet is unchanged by JSON and URL encoding, so an
encoded copy is caught too.
