# @happyvertical/smrt-svelte

Top-of-stack Svelte 5 integration layer for SMRT: the app `Provider`, auth / AI hooks, browser AI (STT/TTS/LLM), forms, server-side i18n, and the domain-aware composites (module, workspace). The domain-agnostic UI primitives, i18n client, theme system, and module UI registry now live in `@happyvertical/smrt-ui` (#1582) — import those from there (e.g. `@happyvertical/smrt-ui/ui`, `@happyvertical/smrt-ui/i18n`). The agent-admin shells (`AgentAdminPanel` / `AgentAdminTabs` / `AgentSettingsShell`) moved to `@happyvertical/smrt-agents` (#1589) so this package no longer depends on `smrt-agents` — import them from `@happyvertical/smrt-agents/svelte/admin` (side-effect-free) or `@happyvertical/smrt-agents/svelte`.

## The UI split — primitive-adoption contract (#1589)

SMRT's shared UI primitives are split by concern: **`smrt-ui` owns the
domain-agnostic VISUAL primitives** (`Button`, `Card`, `Modal`, `Badge`,
`Avatar`, `Chip`, `Dropdown`, …) and **`smrt-svelte` (here) owns the FORM
primitives** (`Input`, `Textarea`, `Select`, `Checkbox`/`Toggle`, `Form`, and the
specialized date/measurement/address/file inputs — they carry i18n + spoken-input
logic that keeps them above the leaf).

Two consequences:

- **This package is the canonical consumer.** smrt-svelte's own composites and
  workspace shell must adopt smrt-ui visual primitives — use `Button`, not a raw
  `<button>`. Only `src/components/forms/` (the form primitives themselves)
  legitimately holds raw `<input>`/`<select>`/`<textarea>`.
- **Domain packages import visual primitives from `smrt-ui` and form primitives
  from `smrt-svelte`**, and must not hand-roll raw interactive markup.

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
| Text/select/number/date/money/address inputs, toggles, file upload, `Form`, `FormGroup` | `@happyvertical/smrt-svelte/forms` |
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
- `@happyvertical/logger` (SDK) is a `dependency` — the browser-safe console logger used for voice/AI error reporting in the form components.
- Peer (all optional): `svelte` >=5.18.2, plus the browser-AI engines (`@huggingface/transformers`, `@mlc-ai/web-llm`, `@remotion/whisper-web`, `@xenova/transformers`) and `chrono-node`.

## Workspace shell primitives

The `./workspace` subpath (`src/components/workspace/`) holds admin-shell primitives:
`WorkspaceShell`, `NavTree`, `Breadcrumbs`, and `ToolsDock` (plus `defineToolsDock` /
`useToolsDock`). Shared types live in `workspace/types.ts` and are re-exported via the
subpath barrel.

**Layering**: primitives first (this folder), opinionated wrapper second (`AdminShell` — deferred),
domain-specific tools live outside the framework in consumer packages.

**Principles**:
- SvelteKit-agnostic — no `$app/state` or `$app/navigation` imports
- SSR-safe — guard all `window` / `localStorage` access
- No token bridges — consume `var(--smrt-color-*)` directly
- Tool IDs are arbitrary strings (extensible, not an enum)

**State-mirroring recipes** (issue #1235):
- Dock events. `'dock:state-changed'` fires on `open()`/`close()`/`toggle()` and
  on availability-driven `activeTool` clears (payload: `{ isOpen, activeTool }`).
  `'dock:context-changed'` fires on `setContext()` with a different reference
  (payload: `{ context }`). Legacy `'dock:change'` (payload: `{ isOpen, activeTool, context }`)
  still fires on every observable transition (incl. badge-only availability
  refresh) for back-compat with consumers mirroring `availableTools` — it's
  `@deprecated`; prefer the granular pair. The `'dock:*'` prefix is reserved
  for built-ins; consumer events should pick a different namespace.
- `WorkspaceShell` exposes `bind:mobileNavOpen` so consumers can lift the drawer
  state. Pair it with `<NavTree onNavigate={() => mobileNavOpen = false} />` to
  close the drawer on navigation without any DOM querying.
- `ToolDef.iconComponent?: Component` renders a custom icon (lucide-svelte etc.)
  inside the rail glyph (and as a leading glyph in topbar layout). Takes
  precedence over `icon: string`, then `label.charAt(0)` as last resort.
- `dock.refreshAvailability()` forces a re-run of `fetchAvailability` with the
  current context. `setContext()` short-circuits on strict-equal references —
  use refresh when a side-channel event (websocket, button) signals availability
  or badges changed without a context change.
- Typed `defineToolsDock<TData, TActions>`. The factory's two generics flow
  into `fetchAvailability`'s `ctx` param and through `ToolsDockContext<TData, TActions>`
  for tool components. Inside a tool, type `context` locally:
  `let { context }: { context: ToolsDockContext<MyData, MyActions> | null } = $props();`.
  `context?.actions?.foo()` is then fully typed — no per-consumer redeclaration.
  `ToolDef` itself is no longer generic (stored as a homogeneous `ToolDef[]`);
  the consumer-side cast at registration is gone, the typed surface lives on
  the component's `context` prop instead.
- Layout positioning. `<ToolsDock layout='topbar'>` renders its own
  `position: fixed` panel — **do not also use `<WorkspaceShell>`'s `inspector`
  snippet** in that mode (the two panels overlap with no z-index coordination).
  `'rail'` layout is safe to compose alongside `inspector` — its panel sits
  inside the dock's own aside.

### RoleShell

Opinionated thin wrapper for multi-role admin shells. Pass a `RoleConfig[]` list
and the current role id; renders `<WorkspaceShell>` + `<NavTree>` + `<Breadcrumbs>`
wired together. Role colors flow through as `--smrt-role-color` CSS custom property.

```svelte
<script lang="ts">
  import { page } from '$app/state';
  import { RoleShell } from '@happyvertical/smrt-svelte/workspace';
  import AccountMenu from '$lib/AccountMenu.svelte';
  import { ROLE_CONFIGS } from '$lib/roles';

  let { data, children } = $props();
  let mobileNavOpen = $state(false);
</script>

<RoleShell
  roles={ROLE_CONFIGS}
  currentRole={data.currentRole}
  currentPath={page.url.pathname}
  bind:mobileNavOpen
>
  {#snippet sidebarFooter()}
    <AccountMenu user={data.user} />
  {/snippet}
  {@render children?.()}
</RoleShell>
```

The `{@render children?.()}` call is the Svelte 5 idiom for rendering a
layout's child route content — replace with the equivalent slot/render call
for your framework if you're not using SvelteKit's `+layout.svelte` flow.

The shell intentionally doesn't know about specific role IDs — consumers pick
whatever set their app needs. Use this for role-based admin dashboards; use
`<WorkspaceShell>` directly for non-role apps.

See epic [happyvertical/smrt#1226](https://github.com/happyvertical/smrt/issues/1226) for context;
implementations land via #1227 (`WorkspaceShell`), #1228 (`NavTree`/`Breadcrumbs`), and #1229
(`ToolsDock` + registry).

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
