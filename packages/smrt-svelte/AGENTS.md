# @happyvertical/smrt-svelte

Top-of-stack Svelte 5 integration layer for SMRT: the app `Provider`, auth / AI hooks, browser AI (STT/TTS/LLM), forms, server-side i18n, and the domain-aware composites (module, workspace). The domain-agnostic UI primitives, i18n client, theme system, and module UI registry now live in `@happyvertical/smrt-ui` (#1582) — import those from there (e.g. `@happyvertical/smrt-ui/ui`, `@happyvertical/smrt-ui/i18n`). The agent-admin shells (`AgentAdminPanel` / `AgentAdminTabs` / `AgentSettingsShell`) moved to `@happyvertical/smrt-agents` (#1589) so this package no longer depends on `smrt-agents` — import them from `@happyvertical/smrt-agents/svelte/admin` (side-effect-free) or `@happyvertical/smrt-agents/svelte`.

## Modules

Per-module semantics live in sibling module docs — read the one for the
subpath you are editing. This file keeps what holds in every module.

| Module | Scope | Module doc |
|---|---|---|
| `src/components/` | what stayed here after the smrt-ui split, the L3 gap primitives, and the import-convention table for picking a barrel | [agents/components.md](agents/components.md) |
| `src/i18n/` (`./i18n` + `./i18n/server`) | `defineMessages` / `useI18n` / `<Trans>` / `buildI18nSnapshot`, the template-vs-render split, and hardcoded-string enforcement | [agents/i18n.md](agents/i18n.md) |
| `src/themes/` + `src/theme/` | which theme system is canonical and the full `--smrt-*` design-token vocabulary with its alias rules | [agents/themes.md](agents/themes.md) |
| `src/test-support/` + `__tests__/` | the golden-test harness and pattern for Svelte component tests | [agents/testing.md](agents/testing.md) |
| `src/components/settings/` (`./settings`) | `SettingsCatalog`, `paginateSettingsCatalog`, and the summary-vs-detail scalability contract | [agents/settings.md](agents/settings.md) |
| `src/components/workspace/` (`./workspace` + `./web`) | the AdminShell family and its principles, the legacy ToolsDock surface, the `./web` activity-feed and `updateAvailable` adapters, and server-side dock gates | [agents/workspace.md](agents/workspace.md) |
| `src/web/remote-query.svelte.ts` | Svelte 5 binding for query-shaped remote pages: rows, page, totals, loading/refreshing/stale/error, retry, last-updated, and query-scoped live subscriptions (#2445) | — |
| `src/web/webmcp-provider.ts` | Provider config for generated data/model WebMCP tools: definitions, effect policy, namespace, budget, legacy/canonical filters, and fetcher seams (#2520) | — |
| `src/web/webmcp-ui.ts` | Fixed, low-cardinality WebMCP adapter over the Provider's mounted form-control and data-surface registries (#2521) | — |

The composed WebMCP fixture in
`src/web/__tests__/webmcp-composed.integration.svelte.test.ts` mounts a real
Provider, rich Form, DataTable/DataSurface, and a bespoke `useWebMcpTool`
component intent. Preserve its lifecycle assertions: SSR and missing
`document.modelContext` are no-ops, mounted tools are fixed-cardinality, and
all registrations abort when their owning component unmounts.

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

The rich `Form` uses smrt-ui's shared staged-edit review contract. Agent
proposals never mutate field bindings directly: they remain staged until a
human applies or discards them in the form's local review surface. Keep this
state machine in smrt-ui; smrt-svelte contributes Provider-backed field
registration and consumes the shared component rather than duplicating it.
The generated WebMCP form tool proposes registry stages; it never writes or
submits field values directly.
Rich `FieldDefinition` registrations may carry a `subject` for record-qualified
identity. The Form bridge also folds live DOM disabled/read-only state into the
registry and omits those fields from WebMCP schemas and staging.

```svelte
<script>
  let { data, children } = $props();
</script>

<Provider user={data.user} permissions={data.permissions}
  ai={{ preload: 'idle', stt: { type: 'whisper-cpp' } }}>
  {@render children()}
</Provider>
```

An object `webmcp` config with `definitions` registers generated data/model
tools through the same registrar as direct smrt-web callers. With no `effects`
policy, only `read`-effect tools register; `write` and `destructive` require
explicit opt-in. Use `filter` for legacy collection definitions and `filterTool`
for canonical definitions; a filter supplied for definitions of the other kind
fails closed. Namespace, budget, resolver, annotation, and atomic-validation
behavior must stay identical between Provider and direct registration. The
authenticated REST route remains the execution authorization boundary.

With the fixed mounted-UI adapter enabled, Provider also owns shared
control/data-surface registries and registers six fixed `smrt_ui_*` tools. This
adapter is a separate, consent-gated surface and is not governed by the
generated-model effect policy. Descendant rich Forms use the shared
control registry unless their explicit `interactionRegistry` prop overrides it.
Supply `webmcp.ui.dataSurfaceRegistry` when mounted surface components already
share an application registry. The adapter resolves registry state at execution
time, never reads the DOM, never accepts agent confirmation, and removes the
entire tool set with one abort signal. A document may have only one active
adapter for a prefix; configure distinct prefixes for intentional coexistence.

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

- Rich Form WebMCP tools only stage review proposals. Structured payloads are
  limited to published schema properties, money uses safe integer minor units,
  and injected legacy registries without `executeBatch` use ordered `execute`
  calls.

- **Preload strategies**: `none`, `eager`, `idle` (recommended), `on-visible`
- **Warm client cache**: module-level Map survives navigation/remounts -- avoids re-downloading WASM/models
- **Adapters**: STT (browser-speech, whisper-cpp, whisper-wasm), TTS (browser-synthesis), LLM (webllm, transformers-llm)
- Cache API: `getCachedSTT()`, `getCachedTTS()`, `getCachedLLM()`, `getCacheStats()`, `clearAllCaches()`

## Permission Action

```svelte
<div use:permission={{ slug: 'articles.delete', permissions: userPermissions }}>Delete</div>
<div use:permission={{ slug: 'articles.delete', permissions: userPermissions, hideOnly: true }}>Delete</div>
```

## Key Files

- `src/Provider.svelte` -- root component, state initialization
- `src/state/` -- SmrtAppStateManager ($state rune), warm client cache
- `src/hooks/` -- useAuth, useSocket, useAppState, useSTT, useTTS, useLLM, useTheme
- `src/components/` -- UI components by category
- `src/themes/` -- ThemeProvider, ThemeSwitcher, CSS presets
- `src/browser-ai/` -- STT/TTS/LLM adapters, capability detection (bundled, not external)
- `src/registry/` -- ModuleUIRegistry for cross-package component discovery

## Dependencies

- `@happyvertical/smrt-types` (shared types) — includes the identity data contracts (`User`, `Role`, `Membership`, `Tenant`) the role/membership components type against, so no dependency on `smrt-users` / `smrt-profiles` is needed
- `@happyvertical/smrt-ui` (UI runtime: primitives, theme system, i18n client, module registry) is a hard `dependency`. The agent-admin shells that used to type against `@happyvertical/smrt-agents/ui` moved to `@happyvertical/smrt-agents/svelte` (#1589), so `smrt-agents` is no longer a dependency here — this drops smrt-svelte below smrt-agents in the package DAG.
- `@happyvertical/smrt-languages` is a hard `dependency` (not an optional peer): the Node-only `/i18n/server` subpath imports its resolver. The browser bundle still excludes it — the client `/i18n` layer never imports the languages root, so it tree-shakes out.
- `@happyvertical/logger` (SDK) is a `dependency` — the console logger used for voice/AI error reporting in the form components. Consume it **only** through `src/internal/logger.ts`, never `createLogger()` at module scope: `createLogger()` reads `HAVE_LOGGER_LEVEL` from `process.env`, so a top-level call throws `ReferenceError: process is not defined` in the browser and kills client-side hydration under `vite dev` (prod builds tree-shake/define it away, so this only bites in dev). The `internal/logger` wrapper constructs the logger lazily and falls back to a bare `ConsoleLogger` when `process.env` is absent, keeping this browser-reachable module (imported by `Provider` + the form primitives) safe.
- Peer (all optional): `svelte` >=5.18.2, plus the browser-AI engines (`@huggingface/transformers`, `@mlc-ai/web-llm`, `@remotion/whisper-web`, `@xenova/transformers`) and `chrono-node`.
