# @happyvertical/smrt-svelte

Top-of-stack Svelte 5 integration layer for SMRT: the app `Provider`, auth / AI hooks, browser AI (STT/TTS/LLM), forms, server-side i18n, and the domain-aware composites (module, workspace). The domain-agnostic UI primitives, i18n client, theme system, and module UI registry now live in `@happyvertical/smrt-ui` (#1582) — import those from there (e.g. `@happyvertical/smrt-ui/ui`, `@happyvertical/smrt-ui/i18n`). The agent-admin shells (`AgentAdminPanel` / `AgentAdminTabs` / `AgentSettingsShell`) moved to `@happyvertical/smrt-agents` (#1589) so this package no longer depends on `smrt-agents` — import them from `@happyvertical/smrt-agents/svelte/admin` (side-effect-free) or `@happyvertical/smrt-agents/svelte`.

## The UI split — primitive-adoption contract (#1589)

SMRT's shared UI primitives are split by concern: **`smrt-ui` owns the
domain-agnostic VISUAL primitives** (`Button`, `Card`, `Modal`, `Badge`,
`Avatar`, `Chip`, `Dropdown`, …) **plus the Provider-free base FORM primitives**
(`Form`, `Input`, `Select`, `Textarea`, `Toggle`, `FormGroup` under
`@happyvertical/smrt-ui/forms` — relocated there in #1589's deferred-forms phase
so domain packages can adopt them without the Provider or a build-graph cycle),
and **`smrt-svelte` (here) owns the Provider-REQUIRED form primitives**
(`CheckboxInput`, the rich `Form`, `TextInput`, `MoneyInput`, and the specialized
date/measurement/address/file inputs — they call `useAppState` / the AI hooks and
carry i18n + spoken-input logic that keeps them above the leaf). This package
re-exports the base **input** primitives (`Input`, `Select`, `Textarea`,
`Toggle`, `FormGroup`) from smrt-ui so `@happyvertical/smrt-svelte/forms` stays
the full barrel — but **not** `Form`: this barrel's `Form` is the rich
Provider-backed one, so import the Provider-free `Form` from
`@happyvertical/smrt-ui/forms` directly.

Two consequences:

- **This package is the canonical consumer.** smrt-svelte's own composites and
  workspace shell must adopt smrt-ui visual primitives — use `Button`, not a raw
  `<button>`. Only `src/components/forms/` (the Provider-required form primitives
  themselves) legitimately holds raw `<input>`/`<select>`/`<textarea>`; the base
  primitives now define those raw elements in `smrt-ui/src/components/forms/`.
- **Domain packages import visual + base form primitives from `smrt-ui` and the
  Provider-required form primitives from `smrt-svelte`**, and must not hand-roll
  raw interactive markup.

Enforced by `scripts/check-raw-primitives.mjs` (report-only during the #1589
migration; flips strict per package as it adopts the primitives).

## Provider (Root Component)

Wraps app in `+layout.svelte`. Provides auth state, permissions, WebSocket, and AI capabilities.

```svelte
<script>
  let { data, children } = $props();
</script>

<Provider user={data.user} permissions={data.permissions}
  ai={{ preload: 'idle', stt: { type: 'whisper-cpp' } }}>
  {@render children()}
</Provider>
```

## Hooks

| Hook | Returns |
|------|---------|
| `useAuth()` | `user`, `isAuthenticated`, `permissions`, `hasPermission()` |
| `useSocket()` | `status`, `isConnected`, `send()`, `reconnect()`, `disconnect()` |
| `useAppState()` | Full `SmrtAppStateManager` -- mode, AI adapters, capabilities |
| `useSTT()` | `start()`, `stop()`, `isListening`, `lastResult`, `interimResult` |
| `useTTS()` | `speak()`, `stop()`, `isSpeaking`, `getVoices()` |
| `useLLM()` | `chat()`, `initialize()`, `unload()`, `isGenerating`, `downloadProgress` |
| `useTheme()` | Theme context from `ThemeProvider` |

## AI System

- **Preload strategies**: `none`, `eager`, `idle` (recommended), `on-visible`
- **Warm client cache**: module-level Map survives navigation/remounts -- avoids re-downloading WASM/models
- **Adapters**: STT (browser-speech, whisper-cpp, whisper-wasm), TTS (browser-synthesis), LLM (webllm, transformers-llm)
- Cache API: `getCachedSTT()`, `getCachedTTS()`, `getCachedLLM()`, `getCacheStats()`, `clearAllCaches()`

## Components

The domain-agnostic primitives (`ui`, `layout`, `feedback`, `nav`, `display`,
`calendar`, `chat`, `permissions`, **`roles`/`memberships`**, `theme`) and the
i18n client / module registry moved to `@happyvertical/smrt-ui` — import them
from there (`@happyvertical/smrt-ui/{ui,layout,feedback,…}`). This package keeps
the top-of-stack, domain-aware pieces:

| Category | Components |
|----------|------------|
| AI | `Provider`, `AILoadingOverlay`, `CapabilityGate`, `DownloadProgress`, `STTTest`, `VoiceInput` |
| Forms (`/forms`) | `TextInput`, `Select`, `MoneyInput`, `DateTimeInput`, `Toggle`, `FileUpload`, `AddressInput`, + more (AI-wired inputs use the hooks/browser-ai here) |
| Module | `ModulePanel` |
| Workspace (`/workspace`) | `WorkspaceShell`, `NavTree`, `Breadcrumbs`, `ToolsDock`, `RoleShell` |

### Gap primitives & S10 consolidation (L3 #1422)

L3 added the generic primitives domain packages were re-rolling, so S10 (#1415)
has a consolidation target: `Avatar`, `Chip`, `Skeleton`, `Tooltip`, `Dropdown`
(menu-button), and `Tree` (flat-DOM ARIA tree, generalizes `NavTree`) under
`./ui`; plus `MessageBubble`, `ReactionPicker`, `TypingIndicator` under the
`./chat` subpath. Each ships with design tokens, keyboard + ARIA a11y, JSDoc'd
props, a golden test, and a playground page (`playground/.../primitives`).

**Adoption-only for S10** — these already meet the library bar; S10 should
migrate domain re-rolls *onto* them rather than build new primitives:

- **`FileUpload`** (`./forms`) — the canonical upload input; replace ad-hoc
  drop zones.
- **`Modal` + forms** (`./feedback` + `./forms`) — compose for dialogs; no
  bespoke modal shells.
- **`ConfirmDialog`** (`./feedback`) — the standard confirm/destructive-action
  flow.
- **`Card`** (`./ui`) — the standard surface/container; retire local card CSS.

### Import convention (S10 #1415)

Domain packages **consume** these primitives; they do not re-roll them. The
duplication of Modal/Form/Button/Avatar across packages is the root cause of
inconsistent a11y, tokens, and states downstream — fix it by importing from the
library. Which barrel for what:

| Need | Import from |
|------|-------------|
| Buttons, cards, badges, avatars, chips, skeletons, tooltips, dropdowns, trees, pagination | `@happyvertical/smrt-svelte/ui` (or the package root) |
| Provider-free base inputs — `Input`, `Select`, `Textarea`, `Toggle`, `FormGroup` | `@happyvertical/smrt-ui/forms` (also re-exported from `@happyvertical/smrt-svelte/forms`) |
| Provider-free `Form` (plain `<form>` wrapper) | `@happyvertical/smrt-ui/forms` **only** — `@happyvertical/smrt-svelte/forms` exports the *rich* Provider-backed `Form` under that name, so import the plain one straight from smrt-ui |
| Provider-backed inputs — `TextInput`, `NumberInput`, `MoneyInput`, date/measurement/address inputs, `CheckboxInput`, file upload, the rich `Form` | `@happyvertical/smrt-svelte/forms` |
| `Modal`, `ConfirmDialog`, `LoadingOverlay`, `ProgressBar` | `@happyvertical/smrt-svelte/feedback` |
| `Container`, `Grid`, `Header`, `Footer`, `PageHeader`, `EmptyState` | `@happyvertical/smrt-svelte/layout` |
| Chat message bubble, reaction picker, typing indicator | `@happyvertical/smrt-svelte/chat` |
| Admin shell, nav tree, breadcrumbs, tools dock | `@happyvertical/smrt-svelte/workspace` |

The package root re-exports `./ui`, `./forms`, etc., so `from
'@happyvertical/smrt-svelte'` also works; prefer the specific subpath in domain
code for tree-shaking and clarity.

**Consolidating an existing re-roll** — two patterns:

1. **Direct use** (preferred for new code and when the local API already matches):
   delete the local component, import the library primitive at each call site.
2. **Thin adapter** (when a package has an established, differing prop vocabulary
   or a `ModuleUIRegistry` registration to preserve): keep the local file but
   reduce it to a wrapper that maps the package's props onto the library
   component — no duplicated markup/styles/logic. Example:
   `chat/.../shared/Avatar.svelte` maps `avatarUrl`→`src` and `onlineStatus`'s
   `dnd`→the library's `busy`, delegating everything else.

**Missing a primitive or prop?** Add it upstream in `smrt-svelte`, don't re-roll
downstream (e.g. the library `Avatar` gained an image-error→initials fallback
while consolidating chat's avatar).

## i18n (`./i18n` + `./i18n/server`, Sweep S13 #1418)

Routes user-facing strings through `@happyvertical/smrt-languages`. The server
pre-resolves a per-locale dictionary of **templates**; the client reads it
synchronously and interpolates `{var}` placeholders with its own dependency-free
`renderTemplate` (`src/i18n/render.ts`, parity-tested against languages — the
client never bundles the heavy languages package). No async in render. The
languages root is imported only by the Node-only `/i18n/server` subpath. See
`docs/content/architecture/i18n.md`.

- **`defineMessages({ key: englishDefault })`** — register a package's English
  code defaults (key namespace `<package>.<component>.<descriptor>`; smrt-svelte
  primitives use `ui.`). Returns a typed key map. Client-safe (no languages
  root import). smrt-svelte's own catalog is `src/i18n/strings.ts`.
- **`useI18n()` → `{ locale, t }`** and **`<Trans key vars />`** — equal
  first-class APIs (`t` for attributes like `placeholder`/`aria-label`, `<Trans>`
  for element bodies). Resolution order: snapshot template → registered default
  → the key itself (never blank). Both work outside a `<Provider>` (fall back to
  registered defaults) so primitives stay usable in isolation/tests.
- **`<Provider i18n={snapshot}>`** puts the store on context; the prop is
  seeded synchronously (SSR-safe) and a locale switch (reassigning `i18n`)
  re-renders every `t` / `<Trans>`.
- **`buildI18nSnapshot({ locale, tenantId, db })`** (`./i18n/server`, Node-only)
  — a consumer's load function calls it for the request locale and passes the
  result to `<Provider>`. It seeds the languages registry from `defineMessages`
  defaults, then resolves each key through the override/tenant/locale chain.
- Enforcement: `scripts/check-hardcoded-strings.mjs` (`pnpm
  check:hardcoded-strings`) flags hardcoded prose in `.svelte` markup —
  report-only until a package's extraction completes, then add it to the
  script's `STRICT_PACKAGES`. Phase 1 extracted `DataTable` as the pilot.

## Permission Action

```svelte
<div use:permission={{ slug: 'articles.delete', permissions: userPermissions }}>Delete</div>
<div use:permission={{ slug: 'articles.delete', permissions: userPermissions, hideOnly: true }}>Delete</div>
```

## Themes

Two theme systems: `src/theme/` (simple ThemeProvider with design tokens) and `src/themes/` (full preset system with material/glass/studio, CSS generation, runtime switching). **`src/themes/` is canonical** — it is the only path that delivers the complete preset-aware `--smrt-*` token surface (colors + typography + spacing + radius + elevation + motion) across material/glass/studio. `src/theme/` is the simpler/legacy provider; it emits the same CSS variable vocabulary from its single built-in scale for backward compatibility, but it does not support preset switching or preset-specific values.

### Design-token vocabulary (issue #1431)

Components consume a Material-3 vocabulary. To keep one vocabulary that always resolves, the canonical names are emitted **plus** additive aliases — never rename canonical tokens:

- **Radius**: canonical `none|sm|md|lg|xl|2xl|3xl|full`; aliases `extra-small|small|medium|large|extra-large`.
- **Spacing**: canonical numeric scale `0…24`; aliases `xs|sm|md|lg|xl|2xl|3xl` mapped onto numeric values.
- **Motion**: canonical `instant|fast|normal|slow|slower`; aliases `short1…long4` (M3 ms scale).
- **Typography**: per-variant `-size|-line-height|-weight|-tracking|-font-family` **plus** a `-font` CSS-shorthand alias (`weight size/line-height family`).
- **Helpers**: `--smrt-font-family-mono`, named `--smrt-typography-weight-{normal,medium,semibold,bold}`, and `--smrt-z-index-{dropdown…tooltip}` (incl. `dialog`).

Single source of truth: `src/themes/shared.ts` (alias maps) → emitted by `src/themes/css-generator.ts` (JS `ThemeProvider`), mirrored into the static preset CSS (`src/themes/styles/*.css`) and the simple provider (`src/theme/tokens.ts`). `scripts/check-svelte-tokens.mjs` (CI + `pnpm check:svelte-tokens`) fails on any consumed-but-unemitted `--smrt-*` token; `src/themes/__tests__/token-aliases.test.ts` pins the emitted set. Don't introduce new `--smrt-*` names in components without emitting them from a delivery path.

## Key Files

- `src/Provider.svelte` -- root component, state initialization
- `src/state/` -- SmrtAppStateManager ($state rune), warm client cache
- `src/hooks/` -- useAuth, useSocket, useAppState, useSTT, useTTS, useLLM, useTheme
- `src/components/` -- UI components by category
- `src/themes/` -- ThemeProvider, ThemeSwitcher, CSS presets
- `src/browser-ai/` -- STT/TTS/LLM adapters, capability detection (bundled, not external)
- `src/registry/` -- ModuleUIRegistry for cross-package component discovery

## Component testing (golden tests)

Component test harness (sweep L4, #1423): `@testing-library/svelte` + `@testing-library/jest-dom` + `@testing-library/user-event` + `axe-core`, wired through `src/test-support/setup.ts` (jest-dom matchers, Testing Library auto-cleanup, a jsdom `<dialog>` `showModal`/`close` polyfill). The smrt-vitest plugin appends its own setup to `setupFiles` — it merges, so don't remove the entry.

**Golden test pattern** — render → assert role/name/state → drive with `user-event` → prove axe-clean. `src/components/ui/__tests__/Button.test.ts` is the reference:

```ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { expectNoA11yViolations } from '../../../test-support/a11y';

render(Component, { props: { /* … */ } });
const el = screen.getByRole('button', { name: 'Save' });
await userEvent.click(el);
expect(el).toHaveAttribute('aria-busy', 'true');
const { container } = render(Component, { props });
await expectNoA11yViolations(container); // axe; color-contrast off (jsdom has no paint)
```

- **Snippet props** (`children`, cell/header renderers): build with `createRawSnippet(() => ({ render: () => '<span>…</span>' }))`.
- **Hook-dependent components** (anything calling `useAppState`/`useSTT`/`useAuth` — they throw outside `<Provider>`): `vi.mock` the hook module with stub defaults. See `src/components/forms/__tests__/Form.test.ts`.
- **Form-input a11y** (programmatic labels, `aria-describedby`, axe-clean for `Input`/`TextInput`/etc.) is L1's deliverable (#1420) on top of this harness — bare primitives like `Input` get behavior tests here, labelled axe coverage there.
- Existing reference suites: Button, Input, Modal, DataTable, Form. The pattern is what sweep S11 (#1416) rolls out repo-wide.

## Dependencies

- `@happyvertical/smrt-types` (shared types) — includes the identity data contracts (`User`, `Role`, `Membership`, `Tenant`) the role/membership components type against, so no dependency on `smrt-users` / `smrt-profiles` is needed
- `@happyvertical/smrt-ui` (UI runtime: primitives, theme system, i18n client, module registry) is a hard `dependency`. The agent-admin shells that used to type against `@happyvertical/smrt-agents/ui` moved to `@happyvertical/smrt-agents/svelte` (#1589), so `smrt-agents` is no longer a dependency here — this drops smrt-svelte below smrt-agents in the package DAG.
- `@happyvertical/smrt-languages` is a hard `dependency` (not an optional peer): the Node-only `/i18n/server` subpath imports its resolver. The browser bundle still excludes it — the client `/i18n` layer never imports the languages root, so it tree-shakes out.
- `@happyvertical/logger` (SDK) is a `dependency` — the console logger used for voice/AI error reporting in the form components. Consume it **only** through `src/internal/logger.ts`, never `createLogger()` at module scope: `createLogger()` reads `HAVE_LOGGER_LEVEL` from `process.env`, so a top-level call throws `ReferenceError: process is not defined` in the browser and kills client-side hydration under `vite dev` (prod builds tree-shake/define it away, so this only bites in dev). The `internal/logger` wrapper constructs the logger lazily and falls back to a bare `ConsoleLogger` when `process.env` is absent, keeping this browser-reachable module (imported by `Provider` + the form primitives) safe.
- Peer (all optional): `svelte` >=5.18.2, plus the browser-AI engines (`@huggingface/transformers`, `@mlc-ai/web-llm`, `@remotion/whisper-web`, `@xenova/transformers`) and `chrono-node`.

## AdminShell workspace surface

The `./workspace` subpath (`src/components/workspace/`) is the canonical
AdminShell family for SMRT admin web apps. It exports the four-edge shell
contract (`AdminShell`, `ShellState`, settings, hotkeys, focus tools,
activities, tenant nav, app/system panels) from `workspace/admin-shell/`.

The first-generation workspace family (`WorkspaceShell`, `RoleShell`,
`NavTree`, `Breadcrumbs`, `ToolsDock`) remains in source as migration reference
only. Do not re-export it from the public `./workspace` barrel just to preserve
compatibility.

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
