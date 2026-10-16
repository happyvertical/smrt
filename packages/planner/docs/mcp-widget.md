# Host-backed Planner resource

## Live local app shell

The development app shell can open `/?kitchenPlan=<plan-id>&kitchenPort=<port>`.
It keeps that binding for navigation in the tab, reads the same Kitchen plan as
the chat MCP tools, and submits edits with the shared revision and command
contract. The bridge is on `127.0.0.1` and accepts only the configured Vite
origin. External chat changes are polled while the page is visible. Local
document persistence is disabled for this mode; standalone Planner continues
to use its usual browser storage. Vite reloads UI code changes in the open
app shell. The Planner's inference selection remains separate from the MCP
plan commands, so the browser can use its own configured inference provider.

For this local QA session, build and watch the sibling `smrt-svelte` and
`smrt-ui` packages, then start Planner with both package directories set:

```sh
# In the smrt worktree, with Node 26:
pnpm --filter @happyvertical/smrt-svelte dev
pnpm --filter @happyvertical/smrt-ui dev
# In this Planner worktree, with Node 26:
SMRT_SVELTE_LOCAL=/absolute/path/to/smrt/packages/smrt-svelte SMRT_UI_LOCAL=/absolute/path/to/smrt/packages/smrt-ui pnpm dev --host 127.0.0.1 --port 5173 --strictPort
```

The Vite aliases apply only when those variables are set. They use the sibling
packages' built exports and one `smrt-ui` theme context; normal builds still
resolve the published dependency. Source changes in the sibling package are
repacked by its watcher and reload the Planner preview. This is a local QA
path for testing upstream component defaults before either repository ships.

Build with Node 26: `pnpm exec svelte-kit sync && node scripts/build-mcp.ts`.
To preview an unreleased shared-shell change in the hosted MCP tab, build the
sibling `smrt-svelte` and `smrt-ui` packages, then run the artifact build with
`SMRT_SVELTE_LOCAL=/absolute/path/to/smrt/packages/smrt-svelte` and
`SMRT_UI_LOCAL=/absolute/path/to/smrt/packages/smrt-ui`. Each variable
selects that package's built exports for the MCP bundle as well as the Vite
preview; omit either to use its published dependency. For unreleased cookbook
engine changes, build `@happyvertical/smrt-types` and `@happyvertical/smrt-core`
first and set `SMRT_CORE_LOCAL=/absolute/path/to/smrt/packages/core` on the
Planner build or preview command as well.
The build writes a self-contained `app/mcp.html` (inline script and styles).
Kitchen injects its MCP Apps bridge before that script. The bridge provides
`window.smrtKitchen.callTool(name, args)` returning structured content and
`subscribe(listener)` returning an unsubscribe function and replaying the latest result.
In local plugin development, Kitchen checks the artifact while the app tab is
visible. A rebuilt artifact replaces the mounted Planner script and styles in
place; the tab and its current plan remain open. Kitchen server code changes
still require restarting the plugin process.

The authoritative tool payload is `{ planId, state: { snapshot, cookbook } }`.
Snapshot and cookbook must be read atomically from the same engine state.
Replayed receipts can refer to an earlier revision; `state` must always be current.

`HostPlanner` mounts the complete cookbook-driven app shell with the Planner
controls available through Customize. The plan's first visible section opens by
default; its sections and model pages are navigable in the hosted app tab. The
controls remain separately exportable for a host with its own shell. One host
mount per document is supported. Tool updates hydrate the
existing singleton stores, which drive both the shell and controls.
UI document edits are captured as one `import_cookbook` command with `replace: true`,
a UUID batch id and the authoritative expected revision. The visible document is
restored while the request runs. This preserves the shared command engine and
  validates the whole edit atomically. Focus remains local. The complete exported
  Planner keeps its save and `onready` lifecycle mounted as routes change.
  Development preview URL parameters are ignored in production builds.
  The hosted theme provider does not load or save browser-local preferences;
  the cookbook remains the source of truth. An invalid first Kitchen payload
  is shown as an error and retried when its plan id is known.
  In local preview, a transport failure pauses the app and exposes the
  preserved edit and a same-id Retry button. A late read from an unmounted
  widget cannot apply to a newly mounted plan.

Controls are disabled while a request is outstanding. A transport failure preserves
the same request/id for explicit retry; an application rejection preserves the draft
and exposes it for copying, and controls stay disabled until that draft is
dismissed, so a later rejection cannot replace it unseen. Stale edits are never automatically rebased or resubmitted.
The wrapper uses host persistence; it does not hydrate or save the cookbook document
in localStorage. Existing panel preferences/sample data remain browser-local.

## UI batch verification contract

The completed QA batch uses the checks below alongside the repository's
documented validation sequence. The Planner and Kitchen issue test matrices
record the executable evidence for each behavior.

| Behavior | Trigger / positive case | Failure case | Context / executor | Runtime / edge | Verification |
| --- | --- | --- | --- | --- | --- |
| Shared authoritative view | Tool state hydrates mounted panels | Missing/malformed document rejected; older revision ignored | One host mount / Kitchen engine | Browser / atomic tool state | Host session test and browser render |
| Hosted app shell | Open the MCP app tab; first plan section, menu, shortcuts, model page, and Customize render | Empty plan opens controls; unknown model falls back to controls | User / CookbookApp | Browser / fragment navigation | Local host browser smoke, focused component test, and native tab check passed 2026-10-11 |
| UI code reload | Rebuild `app/mcp.html` with the native app tab open; shell remounts in place with the same plan | Tab closes, duplicate shell, or stale script | Kitchen MCP bridge / Planner mount | Browser / app-only update tool | Native tab test passed 2026-10-11: temporary marker appeared, normal bundle restored, one Shop shell remained |
| Revision-safe edits | Panel edit submits import at current revision | Conflict preserves draft; no overwrite | User / atomic engine batch | Browser + Node 26 / run_commands | Browser host QA and Kitchen MCP tests |
| Retry | Explicit retry reuses UUID and payload | Ambiguous transport failure leaves controls locked | User / server idempotency journal | MCP bridge / transport loss | Browser host QA and Kitchen MCP tests |
| External updates | Tool notification refreshes same stores | Concurrent local draft retained | Host / engine snapshot | MCP notification / unknown payload | Host session test |
| Local compatibility | Standalone mounts normal Planner | N/A: remote wrapper absent | Browser-local store | Planner app | Full Planner regression suite |

No authentication, tenancy or SQL behavior changes in this adapter. Kitchen owns
plan authorization and persistence.
