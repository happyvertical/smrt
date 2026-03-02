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
  import Provider from '@happyvertical/smrt-svelte';
</script>

<Provider>
  <slot />
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
  import { PermissionCheck } from '@happyvertical/smrt-svelte';
  import { permission } from '@happyvertical/smrt-svelte';
</script>

<PermissionCheck requires="admin:write">
  <button>Admin Action</button>
</PermissionCheck>

<!-- Or as a Svelte action -->
<div use:permission={'admin:read'}>Protected content</div>
```

### Theme System

```svelte
<script>
  import { ThemeProvider } from '@happyvertical/smrt-svelte/themes';
</script>

<ThemeProvider config={{ mode: 'dark' }}>
  <slot />
</ThemeProvider>
```

### Browser AI

```svelte
<script>
  import { useSTT, useTTS, useLLM } from '@happyvertical/smrt-svelte/browser-ai/svelte';
</script>
```

## Exports

### Entry Points

| Import Path | Contents |
|-------------|----------|
| `@happyvertical/smrt-svelte` | Provider, DataTable, permission utilities, hooks, state |
| `@happyvertical/smrt-svelte/admin` | Agent admin panel components |
| `@happyvertical/smrt-svelte/calendar` | Calendar and DayView |
| `@happyvertical/smrt-svelte/content` | Content display components |
| `@happyvertical/smrt-svelte/forms` | Form inputs (TextInput, Select, MoneyInput, etc.) |
| `@happyvertical/smrt-svelte/layout` | Layout (Container, Grid, Header, Footer, Masthead, etc.) |
| `@happyvertical/smrt-svelte/ui` | UI primitives (Button, Card, Badge, Pagination) |
| `@happyvertical/smrt-svelte/themes` | ThemeProvider and theme utilities |
| `@happyvertical/smrt-svelte/registry` | ModuleUIRegistry for agent admin panels |
| `@happyvertical/smrt-svelte/browser-ai` | Browser AI client (STT/TTS/LLM) |
| `@happyvertical/smrt-svelte/browser-ai/svelte` | Svelte hooks for browser AI |
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

### Functions & Actions

`hasPermission`, `hasAnyPermission`, `hasAllPermissions`, `permission` (action), `ripple` (action)

## Dependencies

- `@happyvertical/smrt-types` — shared type definitions
- Peer: `@happyvertical/smrt-agents`, `@happyvertical/smrt-jobs`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-users`
