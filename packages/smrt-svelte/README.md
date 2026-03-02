# @happyvertical/smrt-svelte

Svelte 5 component library for the SMRT framework. Provides UI components, browser AI integration (STT/TTS/LLM with warm cache), a theme system, permission-aware rendering, and module UI registry for agent admin panels.

## Installation

```bash
pnpm add @happyvertical/smrt-svelte
```

## Usage

### Provider Setup

```svelte
<script>
  import { Provider } from '@happyvertical/smrt-svelte';
  let { children } = $props();
</script>

<Provider user={data.user} permissions={data.permissions}
  ai={{ preload: 'idle', stt: { type: 'whisper-cpp' } }}>
  {@render children()}
</Provider>
```

### Form Components

```svelte
<script>
  import { TextInput, Select, MoneyInput, DateTimeInput, Toggle } from '@happyvertical/smrt-svelte/forms';
</script>

<TextInput label="Name" bind:value={name} />
<MoneyInput label="Price" bind:value={price} currency="USD" />
<DateTimeInput label="Launch Date" bind:value={date} />
<Toggle label="Active" bind:checked={active} />
```

### UI Components

```svelte
<script>
  import { Button, Card, Badge, Pagination } from '@happyvertical/smrt-svelte/ui';
  import { DataTable } from '@happyvertical/smrt-svelte';
</script>

<Card>
  <DataTable columns={cols} rows={data} />
  <Pagination total={100} page={1} perPage={20} />
</Card>
```

### Permission-Aware Rendering

```svelte
<script>
  import { PermissionCheck, permission } from '@happyvertical/smrt-svelte';
</script>

<PermissionCheck requires="admin:write">
  <button>Admin Action</button>
</PermissionCheck>

<!-- Or as a Svelte action -->
<div use:permission={{ slug: 'admin:read', permissions: userPermissions }}>
  Protected content
</div>
```

### Theme System

```svelte
<script>
  import { ThemeProvider } from '@happyvertical/smrt-svelte/themes';
</script>

<ThemeProvider preset="glass" colorScheme="system">
  {@render children()}
</ThemeProvider>
```

## Exports

### Entry Points

| Import Path | Contents |
|-------------|----------|
| `@happyvertical/smrt-svelte` | Provider, DataTable, permission utilities, hooks, state, components |
| `@happyvertical/smrt-svelte/admin` | Agent admin panel components |
| `@happyvertical/smrt-svelte/calendar` | Calendar and DayView |
| `@happyvertical/smrt-svelte/forms` | Form inputs (TextInput, Select, MoneyInput, etc.) |
| `@happyvertical/smrt-svelte/layout` | Layout (Container, Grid, Header, Footer, Masthead, etc.) |
| `@happyvertical/smrt-svelte/ui` | UI primitives (Button, Card, Badge, Pagination) |
| `@happyvertical/smrt-svelte/themes` | ThemeProvider, presets (material/glass/studio), CSS generation |
| `@happyvertical/smrt-svelte/registry` | ModuleUIRegistry for agent admin panels |
| `@happyvertical/smrt-svelte/browser-ai` | Browser AI client (STT/TTS/LLM adapters, capability detection) |
| `@happyvertical/smrt-svelte/browser-ai/svelte` | Svelte AI components (VoiceInput, CapabilityGate, etc.) |
| `@happyvertical/smrt-svelte/styles/tokens.css` | Design tokens CSS |

### Components by Category

**Forms**: `AddressInput`, `CheckboxInput`, `DateRangeInput`, `DateTimeInput`, `FileUpload`, `Form`, `FormGroup`, `FormMicButton`, `Input`, `MeasurementInput`, `MoneyInput`, `NumberInput`, `PhoneInput`, `SearchInput`, `Select`, `SelectInput`, `Textarea`, `TextareaInput`, `TextInput`, `Toggle`

**Layout**: `Container`, `EmptyState`, `Footer`, `Grid`, `Header`, `Masthead`, `PageHeader`, `SummaryCard`

**UI**: `Badge`, `Button`, `Card`, `Pagination`

**Display**: `ConfidenceBadge`, `CurrencyDisplay`, `DateDisplay`, `Icon`, `StatusBadge`

**Feedback**: `ConfirmDialog`, `LoadingOverlay`, `Modal`, `ProgressBar`

**Navigation**: `FilterChips`, `Tabs`

**Data**: `DataTable`

**Permissions**: `PermissionCheck`, `RoleBadge`, `RoleSelector`

**Admin**: `AgentAdminPanel`, `AgentAdminTabs`, `AgentSettingsShell`

**Other**: `Calendar`, `DayView`, `MembershipCard`, `MembershipList`, `ModulePanel`

**Browser AI**: `AILoadingOverlay`, `CapabilityGate`, `DownloadProgress`, `STTTest`, `VoiceInput`

### Hooks

`useAuth`, `useSocket`, `useAppState`, `useSTT`, `useTTS`, `useLLM`, `useTheme`

### Functions & Actions

`hasPermission`, `hasAnyPermission`, `hasAllPermissions`, `permission` (action), `ripple` (action)

### Cache API

`getCachedSTT`, `getCachedTTS`, `getCachedLLM`, `getCacheStats`, `clearAllCaches`

## Dependencies

- `@happyvertical/smrt-types` -- shared type definitions
- Peer: `svelte` >=5.18.2, `@happyvertical/smrt-agents`, `@happyvertical/smrt-jobs`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-users` (all optional)
