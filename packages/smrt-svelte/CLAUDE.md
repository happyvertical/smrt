# @happyvertical/smrt-svelte

Svelte 5 components for SMRT user management, permissions, and browser AI (STT/TTS/LLM).

## Provider (Root Component)

Wraps app in `+layout.svelte`. Provides auth state, permissions, WebSocket, and AI capabilities.

```svelte
<Provider user={data.user} permissions={data.permissions}
  ai={{ preload: 'idle', stt: { type: 'whisper-cpp' } }}>
  {@render children()}
</Provider>
```

## Hooks

| Hook | Returns |
|------|---------|
| `useAuth()` | `user`, `isAuthenticated`, `permissions`, `hasPermission()` |
| `useSocket()` | `status`, `send()`, `reconnectAttempts` |
| `useAppState()` | Full state manager — mode, AI adapters, capabilities |

## AI System

- **Preload strategies**: `none`, `eager`, `idle` (recommended), `on-visible`
- **Warm client cache**: module-level Map survives navigation/remounts — avoids re-downloading WASM/models
- **Adapters**: STT (browser-speech, whisper-cpp, whisper-wasm), TTS (browser-synthesis), LLM (webllm, transformers-llm)
- Cache API: `getCachedSTT()`, `getCachedLLM()`, `getCacheStats()`, `clearAllCaches()`

## Components

| Category | Components |
|----------|------------|
| AI | `Provider`, `AILoadingOverlay`, `CapabilityGate`, `DownloadProgress`, `VoiceInput` |
| User | `UserMenu`, `UserCard`, `UserAvatar`, `UserList`, `UserForm`, `InviteUserModal` |
| Permission | `PermissionCheck`, `RoleBadge`, `RoleSelector` |
| Tenant | `TenantSwitcher`, `TenantCard` |
| Forms | `SMRTForm`, `SMRTTextInput`, `SMRTTextarea`, `SMRTNumber`, `SMRTPhone`, `SMRTSelect`, `SMRTDateTime`, `SMRTCheckbox` |

## Permission Directive

```svelte
<button use:permission={'articles.delete'}>Delete</button>
<button use:permission={{ permission: 'articles.delete', action: 'disable' }}>Delete</button>
```

## Themes

Three presets via `ThemeProvider`: `material`, `glass`, `studio`. See `src/themes/README.md`.

## Key Files

- `src/Provider.svelte` — root component, state initialization
- `src/state/` — SmrtAppStateManager ($state rune), warm client cache
- `src/hooks/` — useAuth, useSocket, useAppState
- `src/components/` — UI components by category
- `src/themes/` — ThemeProvider, ThemeSwitcher, CSS presets

## Dependencies

- `@happyvertical/browser-ai` (STT/TTS/LLM adapters)
- `@happyvertical/smrt-users` (User, Tenant, Permission types)
- `svelte` ≥5.18.2 (peer)
