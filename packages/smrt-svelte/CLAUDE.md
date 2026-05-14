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
| UI | `Button`, `Card`, `Badge`, `Pagination` |
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

Two theme systems: `src/theme/` (simple ThemeProvider with design tokens) and `src/themes/` (full preset system with material/glass/studio, CSS generation, runtime switching).

## Key Files

- `src/Provider.svelte` -- root component, state initialization
- `src/state/` -- SmrtAppStateManager ($state rune), warm client cache
- `src/hooks/` -- useAuth, useSocket, useAppState, useSTT, useTTS, useLLM, useTheme
- `src/components/` -- UI components by category
- `src/themes/` -- ThemeProvider, ThemeSwitcher, CSS presets
- `src/browser-ai/` -- STT/TTS/LLM adapters, capability detection (bundled, not external)
- `src/registry/` -- ModuleUIRegistry for cross-package component discovery

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

See epic [happyvertical/smrt#1226](https://github.com/happyvertical/smrt/issues/1226) for context;
implementations land via #1227 (`WorkspaceShell`), #1228 (`NavTree`/`Breadcrumbs`), and #1229
(`ToolsDock` + registry).
