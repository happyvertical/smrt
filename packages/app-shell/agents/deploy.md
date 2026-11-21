# Starting and stopping the published server (#5494)

For a deployment that installs `@happyvertical/smrt-app-shell` from the
registry instead of running from a checkout. Cloud-profile behaviour
(tenants, lifecycle policy, what must not exist there) is in
[cloud-profile.md](cloud-profile.md).

## What the package ships

| Entry | What |
|---|---|
| `smrt-app-shell` (`bin/smrt-app-shell.mjs`) | Starts the server. Same as `node build`. |
| `@happyvertical/smrt-app-shell/start` | `build/index.js`, importable as a start entry (importing it starts listening). |
| `build/` | The SvelteKit adapter-node output (`build/index.js` raises `BODY_SIZE_LIMIT`, then imports `server-start.js`). Published in `files`; a `turbo.json` output and the release workspace archive carry it (without them the published 0.62.1 to 0.66.1 had `dist/` only: the release job archived `*/dist/*` and prepack reused it). |
| `@happyvertical/smrt-app-shell/shutdown` | `installShutdown`, `shutdown`, `resolveDeadlineMs` (below). |

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
its state root), `DATABASE_URL` and the provider settings (hosted). Liveness:
`GET /api/_runtime/health`.

## Stopping: SIGTERM and SIGINT

Installed when the server initialises (`hooks.server.ts`, not under `vite dev`).

1. The signal stops the HTTP listener (adapter-node's handler), so no new
   connection is accepted, and waits until every request already accepted has
   ended.
2. `drainShell(remaining)` then refuses new apps, waits for calls and wakes in
   flight, and closes every open app (workers, pools, the per-app claim).
3. Exit 0 when both finished inside the deadline. Exit 1 when a request or an
   app call outlasted it (the apps are then closed anyway), or when the drain
   itself never returns (the process leaves 1 s after the deadline).

The listener stops first on purpose: `drainShell` refuses new apps from its
first line, so a request arriving after it would be refused halfway. A repeated
signal joins the shutdown already running.

Deadline: `SMRT_APP_SHELL_SHUTDOWN_MS` (whole milliseconds, default 30000),
or `installShutdown({ deadlineMs })`. The listener gets at most half of it; set
adapter-node's `SHUTDOWN_TIMEOUT` (seconds) at or below the deadline, and the
orchestrator's termination grace period above it (Kubernetes
`terminationGracePeriodSeconds`).

Embedding hosts:

```ts
import { installShutdown } from '@happyvertical/smrt-app-shell/shutdown';
installShutdown({ drain: myDrain, stopAccepting: () => closeMyListener(), onExit: process.exit });
```

### What the drain does not cover

`drainShell` waits only on leases, and leases exist only for the `cloud`
profile with a `lifecycle` policy (`host.ts`, `lifecycleOn()`). On the local
profile, or an unconfigured cloud one, it has nothing to wait on and goes
straight to closing the apps. A publish or other app call is therefore protected
by step 1 (the HTTP request it runs in finishes before the drain starts, within
the deadline), not by step 2. Work that outlives its request (a background job,
the assistant's change review) is not waited for on either profile. A request
still open at the deadline is cut with exit 1.

## Node version

`engines.node` is `>=26.0.0` (root and this package); CI runs 26.12.1 and the
worker bundle targets `node26` (`tools/bundle-worker.mjs`). That floor was
raised from 24 for the whole repository in #3340 (policy: CI and the template
image run 26). A search of this package found no API that only Node 26 has;
the shell uses `node:sqlite` (through app-runtime), which Node 24 also ships,
but nothing here is tested on 24. Supported: Node 26 or newer. The org standard
of 24 is not the supported runtime for this package.
