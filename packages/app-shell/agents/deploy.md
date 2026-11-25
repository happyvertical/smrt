# Starting and stopping the published server (#5494)

For a deployment that installs `@happyvertical/smrt-app-shell` from the
registry instead of running from a checkout. Cloud-profile behaviour
(tenants, lifecycle policy, what must not exist there) is in
[cloud-profile.md](cloud-profile.md).

## What the package ships

| Entry | What |
|---|---|
| `smrt-app-shell` (`bin/smrt-app-shell.mjs`) | Starts the server. Same as `node build`. |
| `smrt-app-shell migrate-to-postgres --tenant <id> --user <owner id>` | One operator command (`build/operator.js`, #5193): moves a tenant's SQLite app into its PostgreSQL schema as the verified owner, then exits (0 done, 1 refused or the shell did not start, 2 usage). Hosted profile only; [cloud profile](cloud-profile.md). |
| `@happyvertical/smrt-app-shell/start` | `build/index.js`, importable as a start entry (importing it starts listening). |
| `build/` | The SvelteKit adapter-node output (`build/index.js` raises `BODY_SIZE_LIMIT`, then imports `server-start.js`). Published in `files`; a `turbo.json` output and the release workspace archive carry it (without them the published 0.62.1 to 0.66.1 had `dist/` only: the release job archived `*/dist/*` and prepack reused it). |
| `@happyvertical/smrt-app-shell/embed` | `build/embed.js`: `handler` (Node request listener, also Express/Connect middleware) and `drain`. Importing it initialises the shell and listens on nothing (below). |
| `@happyvertical/smrt-app-shell/shutdown` | `installShutdown`, `shutdown`, `createDrain`, `resolveDeadlineMs` (below). |

`./start` is built on the two `./embed` pieces: `build/index.js` (from `tools/start-entry.js`) loads the handler, lets adapter-node start its listener (`build/server-start.js`), takes over adapter-node's SIGTERM/SIGINT handler as the drain's listener step, and exits with the drain's code. `build/embed.js` is `tools/embed-entry.js`; its types are `src/lib/server/embed.ts`. `hooks.server.ts` installs no signal handler: it publishes the drain (`registerEmbeddedDrain`, a `Symbol.for` slot, because the server bundle and the entries are separate module instances).

`pnpm verify:exports` (run by prepack, also on a reused CI build) fails when
any file `exports` or `bin` names is missing, so a package without its server
build is rebuilt, never published. `pnpm test:packed` packs, extracts into an
empty directory, starts the server from the tarball and checks health and
SIGTERM (`src/packed-start.test.ts`).

## Starting

```sh
npx smrt-app-shell        # or: node node_modules/@happyvertical/smrt-app-shell/bin/smrt-app-shell.mjs
```

Configuration is environment only. adapter-node reads `HOST`, `PORT`,
`SOCKET_PATH`, `ORIGIN`, `SHUTDOWN_TIMEOUT` (seconds, default 30). The profile
and storage come from app-runtime: `SMRT_RUNTIME_PROFILE`, `SMRT_APP_ID`,
`SMRT_DATA_DIR` (local; a dedicated directory outside the working directory and
its state root), `DATABASE_URL` and the provider settings (hosted). Hosted apps
on PostgreSQL optionally split the credentials: `DATABASE_URL` stays the admin and
`SMRT_APP_SHELL_RUNTIME_DATABASE_URL` is the unprivileged login user operations
run as (cloud-profile.md "User apps on PostgreSQL"); the shared pool and the
operation deadline have their own `SMRT_APP_SHELL_*` variables there. Hosted start
refuses a `DATABASE_URL` login that is a superuser or has BYPASSRLS (it would void
the shell tables' row-level security; opt-out `SMRT_UNSAFE_ALLOW_RLS_BYPASS=1`,
tests and local development only; cloud-profile.md). Liveness:
`GET /api/_runtime/health`.

## Stopping: SIGTERM and SIGINT

Installed by `./start` (`build/index.js`) once the server has initialised; not under `vite dev`, and not by `./embed`.

One ordered sequence, owned by `shutdown.ts`; a step that throws or runs past
its limit makes the exit non-zero but never skips the later steps, and the
process exits only after all of them returned:

1. Open event streams (`/api/events`) are ended and new ones answered 503
   (`Retry-After`); an idle browser tab would otherwise hold the listener open.
2. The HTTP listener stops (adapter-node's handler) and every request already
   accepted runs to its end. This step gets at most half the deadline; requests
   still running then are cut at the exit.
3. Workbook imports stop (`stopShellImports`) and the jobs they are running
   finish (local profile; nothing on the hosted one). This replaces the old
   separate `sveltekit:shutdown` listener, which raced the drain.
4. `drainShell(remaining)` refuses new apps, waits for calls and wakes in
   flight, and closes every open app (workers, pools, the per-app claim).
5. Exit 0 when every step finished inside the deadline. Exit 1 otherwise (the
   apps are closed anyway), or when a step never returns (the process leaves
   1 s after the deadline).

`SMRT_APP_SHELL_PREDRAIN_MS` (whole milliseconds, default 0 = today's behaviour) keeps `./start`'s listener open and serving for that long after the signal, before step 1; the deadline below starts after it. Use it when a load balancer needs time to stop sending traffic (the shell's health endpoint stays 200 during the delay: readiness is the host's to flip, see Embedding).

Deadline: `SMRT_APP_SHELL_SHUTDOWN_MS` (whole milliseconds, default 30000),
or `installShutdown({ deadlineMs })`. The listener gets at most half of it; set
adapter-node's `SHUTDOWN_TIMEOUT` (seconds) at or below the deadline, and the
orchestrator's termination grace period above it, plus
`SMRT_APP_SHELL_PREDRAIN_MS` and 1 s (Kubernetes `terminationGracePeriodSeconds`).

## Embedding: the host owns the listener, the signals and the exit

A host behind a load balancer wants the opposite of `./start`: keep listening,
answer its readiness endpoint 503 until traffic has moved away, stop the shell,
then close and exit. Use `./embed`:

```ts
import http from 'node:http';
import { drain, handler } from '@happyvertical/smrt-app-shell/embed';

let ready = true;
const server = http.createServer((req, res) => {
  if (req.url === '/ready') {
    res.statusCode = ready ? 200 : 503; // the load balancer's probe
    return void res.end();
  }
  return handler(req, res); // everything else is the shell
});
server.listen(3000);

async function stop() {
  ready = false; // 1. readiness 503: the balancer stops sending traffic
  await new Promise((r) => setTimeout(r, 5_000)); //    ...and drains its side
  const result = await drain(); // 2. end streams, finish imports, close apps
  if (!result.clean) console.error('shell drain', result.steps); // which step failed
  server.close(); // 3. only now close YOUR listener, and exit
  server.closeAllConnections();
  process.exit(result.code);
}
process.once('SIGTERM', stop);
```

- `handler(req, res, next?)` serves static files, then the app; `next` is only
  a fallback (default 404). Importing `./embed` raises `BODY_SIZE_LIMIT` for
  workbook imports unless you set it first.
- `drain(call?)` runs steps 1, 3 and 4 above (streams, imports, apps). It never
  closes a listener, installs a signal handler or calls `process.exit`. It
  returns the same promise on every call, never rejects, and resolves by the
  deadline plus 1 s (`SMRT_APP_SHELL_SHUTDOWN_MS`, default 30 s) even if a step
  hangs. The result is `{ code, clean, closed, busy, steps }`; `steps` maps
  `endStreams`, `stopAccepting`, `stopWork`, `drain` to `ok`, `skipped`,
  `failed`, `timeout` or `busy`. `stopAccepting` is `skipped` unless you pass
  `drain({ stopAccepting })` for a listener step of your own, which then runs
  second, as in `./start`.
- A step that outlasts the deadline is reported `timeout` and the promise
  resolves, but the sequence keeps going in the background (the later steps
  still run, so the apps still close).
- `drain` installs no signal handler. Importing `./embed` initialises the
  runtime, which, when `ORIGIN` is a loopback origin, installs its own
  SIGTERM/SIGINT handlers to remove the origin file; keep your own handler
  registered, or the process is re-killed when none exists.
- After the drain the shell refuses new app work; requests that still reach
  `handler` get errors. Close your listener next.

Hosts that build their own process around the engine-free sequence can use
`createDrain({ drain, endStreams, stopWork })` or `installShutdown`:

```ts
import { installShutdown } from '@happyvertical/smrt-app-shell/shutdown';
installShutdown({ drain: myDrain, stopAccepting: () => closeMyListener(), onExit: process.exit });
```

### What the drain does not cover

`drainShell` waits only on leases, and leases exist only for the `cloud`
profile with a `lifecycle` policy (`host.ts`, `lifecycleOn()`). On the local
profile, or an unconfigured cloud one, it has nothing to wait on and goes
straight to closing the apps. A publish or other app call is therefore protected
by step 2 (the HTTP request it runs in finishes before the drain starts, within
the deadline), not by step 4. Work that outlives its request is not waited for, except workbook imports (step 3); the assistant's change review is not. A request
still open at its limit is cut with exit 1.

## Node version

`engines.node` is `>=26.0.0` (root and this package); CI runs 26.12.1 and the
worker bundle targets `node26` (`tools/bundle-worker.mjs`). That floor was
raised from 24 for the whole repository in #3340 (policy: CI and the template
image run 26). A search of this package found no API that only Node 26 has;
the shell uses `node:sqlite` (through app-runtime), which Node 24 also ships,
but nothing here is tested on 24. Supported: Node 26 or newer. The org standard
of 24 is not the supported runtime for this package.

## Desktop

The desktop wrapper stops the sidecar with SIGTERM, waits 10 s, then SIGKILLs
(`smrt-desktop/wrapper/src/shutdown.rs`, `graceful_timeout`). The default
deadline (30 s) is longer than that, so a shutdown that needs more than 10 s
(a long import) is killed by the wrapper; set `SMRT_APP_SHELL_SHUTDOWN_MS` at or
below 10000 there if an exit code matters.
