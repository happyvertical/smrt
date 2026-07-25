# smrt-svelte/workspace / AdminShell

Module semantics for `src/components/workspace/` (`./workspace` + `./web`). Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## AdminShell workspace surface

The `./workspace` subpath (`src/components/workspace/`) is the canonical
AdminShell family for SMRT admin web apps. It exports the four-edge shell
contract (`AdminShell`, `ShellState`, settings, hotkeys, focus tools,
activities, tenant nav, app/system panels) from `workspace/admin-shell/`.

The first-generation workspace family (`WorkspaceShell`, `RoleShell`,
`NavTree`, `Breadcrumbs`, `ToolsDock`) remains in source as migration reference
only. Do not re-export it from the public `./workspace` barrel just to preserve
compatibility. Applications that still need ToolsDock during migration may use
the explicit `@happyvertical/smrt-svelte/workspace/legacy` subpath; keep legacy
additions isolated there so the canonical workspace surface remains AdminShell.

**Principles**:
- SvelteKit-agnostic core — no `$app/state` or `$app/navigation` imports
- SSR-safe public shell import/render path; browser listeners and localStorage
  activate after mount
- No token bridges — consume `var(--smrt-color-*)` directly
- App-owned configuration for hidden edges, push/overlay presentation, and
  exclusivity groups
- User-owned preferences persist as sparse `ShellSettingsDelta` values
- Focus tools may register imperatively through `ShellState` or declaratively
  through Svelte helpers
- Shell activities are client-side records; server jobs, polling, WebSockets,
  and `smrt-web` SSE can feed them through app adapters

See `src/components/workspace/MIGRATION.md` for the old-to-new concept map.

### Live activity feed adapter (`./web`, #1779)

`activityFeed({ collection, map, shell })` (from `@happyvertical/smrt-svelte/web`)
bridges a `@happyvertical/smrt-web` live collection into a `ShellState` activity
registry: it subscribes the collection through `liveCollection`, reactively maps
each row → `ShellActivity` via the app-supplied editorial `map`, and drives
`upsertActivity` / `updateActivity` / `removeActivity` as rows appear, change,
and vanish (a row mapping to `null` is excluded / retracted). Returns a disposer
that removes exactly the activities it created. Must be called during component
init (installs a `$effect`); the subscription tears down on unmount.

It lives behind the opt-in `./web` entry — which pulls the TanStack client-data
engine — and is **never** imported under `components/workspace/`, so the
AdminShell core (`./workspace`) stays transport-agnostic and TanStack-free (epic
#1766). The pure diff core is `ActivityFeedReconciler` (engine-free, unit-tested
against a real `ShellState`). Demo: `playground/.../admin-shell-activity-feed`.

### `updateAvailable` binding (`./web`, #1764)

`useUpdateAvailable({ state, updated? })` (from `@happyvertical/smrt-svelte/web`)
is the Svelte 5 reactive wrapper over smrt-web's framework-free `UpdateState`
(from `createUpdateState()`). It surfaces `updateAvailable` / `bundle` /
`contract` reactively (`$state`/`$derived`) for a toast or reload prompt, and
wires SvelteKit's native `updated` store as the **bundle** signal. The
**contract** signal (a manifest-hash change across loads, or a live `_events`
manifest-frame mismatch latched by smrt-web on reconnect) is surfaced as-is.

`updated` is passed IN as a reactive accessor (`() => updated.current` on modern
`$app/state`, or a `$derived` over the legacy `$updated` store) rather than
imported here — `$app/*` only resolves inside a SvelteKit app, so a library that
imported it could not build/test standalone; the other `./web` adapters take
runtime input the same way. Must be called during component init (installs
`$effect`s that subscribe to the primitive and watch `updated`); both tear down
on unmount. Construct ONE `createUpdateState()` per app (it owns the durable
last-seen-hash bookkeeping) and pass its `manifestHash` from
`@happyvertical/smrt-virt-web`. Browser-safe, engine-free (no `@tanstack/*`
type). NOTE: `.svelte.ts` runes tests may not run under the local Darwin/vite8
toolchain (CI is the gate) — the binding is covered by typecheck + svelte-check +
a light unit test.

### Dock availability gates (server-side)

`ToolDef.gates?: string[]` declares the gates a tool must pass to be visible.
Convention: `<prefix>:<identifier>` (e.g. `permission:articles.publish`,
`feature:video-tools`, `myapp:show-jobs`). `composeDockAvailability` from
`@happyvertical/smrt-svelte/workspace/server` evaluates them — register one
evaluator per prefix, throws on unknown prefixes (loud-fail beats silent-leak),
AND semantics across a tool's gates. Node-safe, no Svelte imports.

The framework does NOT ship built-in evaluators — every prefix the dock sees
must have a caller-supplied evaluator in the map (otherwise composition
throws). `permission:` and `feature:` are recommended conventions for
ecosystem cohesion (consumers typically wire `PermissionResolver` from
smrt-users and `FeatureResolver` from smrt-features as those evaluators), but
they're not reserved — apps may pick any namespace. App-specific gates
should use a dedicated namespace (e.g. `myapp:`) to avoid colliding with
future built-ins.

Recommended pattern: in the consumer's `+server.ts` endpoint that backs
`fetchAvailability`, wrap `PermissionResolver` (smrt-users) and `FeatureResolver`
(smrt-features) as evaluators and pass them in. Tools without `gates` stay
unconditionally visible (back-compat). Anytown's hand-coded
`apps/dashboard/src/lib/server/content-tool-dock.ts` is a candidate for
migration in a follow-up.

Legacy ToolsDock treats availability fetch failures as degraded presentation
state: it preserves the current context's last successful tool IDs, labels,
and badges. Before the first success, or after a context change, it falls back
to registered-tool metadata so contextual values do not cross boundaries.
Consumers can read `dock.availabilityError` to surface the current context's
failure; a context change or later successful refresh clears the signal, and
success applies the new snapshot.
Availability is never an authorization boundary—server operations must still
enforce permissions.

### Live activity feed adapter (`./web`, #1779)

`activityFeed({ collection, map, shell })` (from `@happyvertical/smrt-svelte/web`)
bridges a `@happyvertical/smrt-web` live collection into a `ShellState` activity
registry: it subscribes the collection through `liveCollection`, reactively maps
each row → `ShellActivity` via the app-supplied editorial `map`, and drives
`upsertActivity` / `updateActivity` / `removeActivity` as rows appear, change,
and vanish (a row mapping to `null` is excluded / retracted). Returns a disposer
that removes exactly the activities it created. Must be called during component
init (installs a `$effect`); the subscription tears down on unmount.

It lives behind the opt-in `./web` entry — which pulls the TanStack client-data
engine — and is **never** imported under `components/workspace/`, so the
AdminShell core (`./workspace`) stays transport-agnostic and TanStack-free (epic
#1766). The pure diff core is `ActivityFeedReconciler` (engine-free, unit-tested
against a real `ShellState`). Demo: `playground/.../admin-shell-activity-feed`.

### `updateAvailable` binding (`./web`, #1764)

`useUpdateAvailable({ state, updated? })` (from `@happyvertical/smrt-svelte/web`)
is the Svelte 5 reactive wrapper over smrt-web's framework-free `UpdateState`
(from `createUpdateState()`). It surfaces `updateAvailable` / `bundle` /
`contract` reactively (`$state`/`$derived`) for a toast or reload prompt, and
wires SvelteKit's native `updated` store as the **bundle** signal. The
**contract** signal (a manifest-hash change across loads, or a live `_events`
manifest-frame mismatch latched by smrt-web on reconnect) is surfaced as-is.

`updated` is passed IN as a reactive accessor (`() => updated.current` on modern
`$app/state`, or a `$derived` over the legacy `$updated` store) rather than
imported here — `$app/*` only resolves inside a SvelteKit app, so a library that
imported it could not build/test standalone; the other `./web` adapters take
runtime input the same way. Must be called during component init (installs
`$effect`s that subscribe to the primitive and watch `updated`); both tear down
on unmount. Construct ONE `createUpdateState()` per app (it owns the durable
last-seen-hash bookkeeping) and pass its `manifestHash` from
`@happyvertical/smrt-virt-web`. Browser-safe, engine-free (no `@tanstack/*`
type). NOTE: `.svelte.ts` runes tests may not run under the local Darwin/vite8
toolchain (CI is the gate) — the binding is covered by typecheck + svelte-check +
a light unit test.

### Dock availability gates (server-side)

`ToolDef.gates?: string[]` declares the gates a tool must pass to be visible.
Convention: `<prefix>:<identifier>` (e.g. `permission:articles.publish`,
`feature:video-tools`, `myapp:show-jobs`). `composeDockAvailability` from
`@happyvertical/smrt-svelte/workspace/server` evaluates them — register one
evaluator per prefix, throws on unknown prefixes (loud-fail beats silent-leak),
AND semantics across a tool's gates. Node-safe, no Svelte imports.

The framework does NOT ship built-in evaluators — every prefix the dock sees
must have a caller-supplied evaluator in the map (otherwise composition
throws). `permission:` and `feature:` are recommended conventions for
ecosystem cohesion (consumers typically wire `PermissionResolver` from
smrt-users and `FeatureResolver` from smrt-features as those evaluators), but
they're not reserved — apps may pick any namespace. App-specific gates
should use a dedicated namespace (e.g. `myapp:`) to avoid colliding with
future built-ins.

Recommended pattern: in the consumer's `+server.ts` endpoint that backs
`fetchAvailability`, wrap `PermissionResolver` (smrt-users) and `FeatureResolver`
(smrt-features) as evaluators and pass them in. Tools without `gates` stay
unconditionally visible (back-compat). Anytown's hand-coded
`apps/dashboard/src/lib/server/content-tool-dock.ts` is a candidate for
migration in a follow-up.

Legacy ToolsDock treats availability fetch failures as degraded presentation
state: it preserves the current context's last successful tool IDs, labels,
and badges. Before the first success, or after a context change, it falls back
to registered-tool metadata so contextual values do not cross boundaries.
Consumers can read `dock.availabilityError` to surface the current context's
failure; a context change or later successful refresh clears the signal, and
success applies the new snapshot.
Availability is never an authorization boundary—server operations must still
enforce permissions.
