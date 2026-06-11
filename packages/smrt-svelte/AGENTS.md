# @happyvertical/smrt-svelte

Svelte 5 components for SMRT: generic UI, forms, permissions, browser AI (STT/TTS/LLM), themes, and module UI registry.

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

| Category | Components |
|----------|------------|
| AI | `Provider`, `AILoadingOverlay`, `CapabilityGate`, `DownloadProgress`, `STTTest`, `VoiceInput` |
| Forms | `TextInput`, `Select`, `MoneyInput`, `DateTimeInput`, `Toggle`, `FileUpload`, `AddressInput`, + more |
| Layout | `Container`, `Grid`, `Header`, `Footer`, `Masthead`, `PageHeader`, `EmptyState`, `SummaryCard` |
| UI | `Button`, `Card`, `Badge`, `Pagination`, `Avatar`, `Chip`, `Skeleton`, `Tooltip`, `Dropdown`, `Tree` |
| Display | `ConfidenceBadge`, `CurrencyDisplay`, `DateDisplay`, `Icon`, `StatusBadge` |
| Feedback | `ConfirmDialog`, `LoadingOverlay`, `Modal`, `ProgressBar` |
| Nav | `FilterChips`, `Tabs` |
| Permission | `PermissionCheck`, `RoleBadge`, `RoleSelector` |
| Admin | `AgentAdminPanel`, `AgentAdminTabs`, `AgentSettingsShell` |
| Other | `Calendar`, `DayView`, `MembershipCard`, `MembershipList`, `ModulePanel`, `DataTable` |

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

- `@happyvertical/smrt-types` (shared types)
- Peer: `svelte` >=5.18.2, `@happyvertical/smrt-agents`, `@happyvertical/smrt-jobs`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-users` (all optional)

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
