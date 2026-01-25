# @happyvertical/smrt-svelte

Svelte 5 components for SMRT user management and browser AI features. Provides reactive state management, authentication, permissions, and AI capabilities (STT, TTS, LLM) with warm client caching.

## Quick Start

```svelte
<!-- +layout.svelte -->
<script>
  import { Provider } from '@happyvertical/smrt-svelte';
  let { data, children } = $props();
</script>

<Provider
  user={data.user}
  permissions={data.permissions}
  ai={{
    preload: 'idle',
    stt: { type: 'whisper-cpp' }
  }}
>
  {@render children()}
</Provider>
```

## Provider

The root component that provides app-wide state for authentication, permissions, sockets, and AI.

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `mode` | `'default' \| 'smrt'` | auto-detected | Force a specific mode |
| `autoEnableSmrt` | `boolean` | `true` | Auto-enable smrt mode when AI is available |
| `user` | `User \| null` | `null` | Current user from your load function |
| `permissions` | `string[]` | `[]` | User's resolved permissions |
| `socket` | `SocketConfig` | - | WebSocket configuration |
| `ai` | `AIConfig` | - | AI preloading configuration |
| `onReady` | `() => void` | - | Called when capabilities detected |
| `onModeChange` | `(mode) => void` | - | Called when mode changes |
| `onAILoadingChange` | `(state) => void` | - | Called when AI loading state changes |

### Example with Full Configuration

```svelte
<Provider
  user={data.user}
  permissions={data.permissions}
  socket={{
    url: 'wss://api.example.com/ws',
    reconnect: { enabled: true, maxAttempts: 5 }
  }}
  ai={{
    preload: 'idle',
    stt: { type: 'whisper-cpp', model: 'tiny.en' },
    tts: { type: 'browser-synthesis' },
    llm: { type: 'webllm', model: 'Llama-3.1-8B-Instruct' },
    showLoadingOverlay: true,
    loadingMessage: 'Preparing AI...'
  }}
  onReady={() => console.log('Capabilities detected')}
  onAILoadingChange={(state) => console.log('AI:', state.phase)}
>
  <slot />
</Provider>
```

---

## AI Preloading & Warm Clients

The AI system uses a warm client cache to avoid re-downloading models on every navigation. Models are downloaded once and cached in memory for the session.

### AIConfig

```typescript
interface AIConfig {
  /** When to preload models */
  preload?: 'none' | 'eager' | 'idle' | 'on-visible';
  /** STT configuration */
  stt?: {
    type: 'browser-speech' | 'whisper-cpp' | 'whisper-wasm';
    model?: string;
    enabled?: boolean;
  };
  /** TTS configuration */
  tts?: {
    type: 'browser-synthesis';
    voice?: string;
    enabled?: boolean;
  };
  /** LLM configuration */
  llm?: {
    type: 'webllm' | 'transformers-llm';
    model?: string;
    enabled?: boolean;
  };
  /** Show loading overlay during download */
  showLoadingOverlay?: boolean;
  /** Custom loading message */
  loadingMessage?: string;
}
```

### Preload Strategies

| Strategy | Description |
|----------|-------------|
| `'none'` | Don't preload. Initialize on first use. |
| `'eager'` | Preload immediately when Provider mounts. |
| `'idle'` | Preload during browser idle time (`requestIdleCallback`). Recommended. |
| `'on-visible'` | Preload when a SMRT AI component becomes visible. |

### Warm Client Cache

The cache persists across Svelte component lifecycles (navigation, remounts):

```typescript
import {
  getCachedSTT,
  getCachedLLM,
  getCacheStats,
  clearAllCaches
} from '@happyvertical/smrt-svelte';

// Check cache status
const stats = getCacheStats();
console.log(stats.stt.types);  // ['whisper-cpp']
console.log(stats.llm.keys);   // ['webllm:Llama-3.1-8B-Instruct']

// Clear all cached adapters (frees memory)
await clearAllCaches();
```

### AILoadingOverlay

Shows download progress during model initialization:

```svelte
<script>
  import { AILoadingOverlay } from '@happyvertical/smrt-svelte';
</script>

<!-- Auto-shown by Provider when ai.showLoadingOverlay is true -->
<!-- Or use manually: -->
<AILoadingOverlay
  message="Loading AI models..."
  showDetails={true}
  dismissible={true}
/>
```

---

## Hooks

### useAuth

Access authentication state:

```svelte
<script>
  import { useAuth } from '@happyvertical/smrt-svelte';

  const { user, isAuthenticated, permissions, hasPermission, hasAnyPermission } = useAuth();
</script>

{#if $isAuthenticated}
  <p>Welcome, {$user.email}</p>
  {#if hasPermission('articles.create')}
    <button>Create Article</button>
  {/if}
{/if}
```

### useSocket

Access WebSocket state:

```svelte
<script>
  import { useSocket } from '@happyvertical/smrt-svelte';

  const { status, send, reconnectAttempts } = useSocket();
</script>

<p>Socket: {$status}</p>
<button onclick={() => send({ type: 'ping' })}>Ping</button>
```

### useAppState

Access the full app state manager:

```svelte
<script>
  import { useAppState } from '@happyvertical/smrt-svelte';

  const appState = useAppState();

  // Access state
  const mode = appState.state.mode;
  const aiLoading = appState.aiLoading;

  // Methods
  appState.toggleMode();
  await appState.initializeSTT({ type: 'whisper-cpp' });
  await appState.speak('Hello world');
</script>
```

---

## Components

### AI Components

| Component | Description |
|-----------|-------------|
| `Provider` | Root provider for state and AI |
| `AILoadingOverlay` | Full-screen loading overlay |
| `CapabilityGate` | Conditionally render based on AI capabilities |
| `DownloadProgress` | Progress bar for model downloads |
| `VoiceInput` | Voice input field with STT |

### User Management Components

| Component | Description |
|-----------|-------------|
| `UserMenu` | User dropdown with logout |
| `UserCard` | Display user info |
| `UserAvatar` | User avatar with initials fallback |
| `UserList` | Paginated user list |
| `UserForm` | User create/edit form |
| `InviteUserModal` | Modal to invite users |

### Permission Components

| Component | Description |
|-----------|-------------|
| `PermissionCheck` | Conditionally render based on permissions |
| `RoleBadge` | Display role as badge |
| `RoleSelector` | Role selection dropdown |

### Tenant Components

| Component | Description |
|-----------|-------------|
| `TenantSwitcher` | Switch between tenants |
| `TenantCard` | Display tenant info |

### Form Components

| Component | Description |
|-----------|-------------|
| `SMRTForm` | Form with voice input support |
| `SMRTTextInput` | Text input with voice |
| `SMRTTextarea` | Textarea with voice |
| `SMRTNumber` | Number input |
| `SMRTPhone` | Phone number input |
| `SMRTSelect` | Select dropdown |
| `SMRTDateTime` | Date/time picker with natural language |
| `SMRTCheckbox` | Checkbox input |

---

## Permission Directive

Use the `permission` action for declarative permission checks:

```svelte
<script>
  import { permission } from '@happyvertical/smrt-svelte';
</script>

<!-- Hide if no permission -->
<button use:permission={'articles.delete'}>Delete</button>

<!-- Disable instead of hide -->
<button use:permission={{ permission: 'articles.delete', action: 'disable' }}>
  Delete
</button>

<!-- Require multiple permissions -->
<button use:permission={{ permissions: ['articles.edit', 'articles.publish'], mode: 'all' }}>
  Publish
</button>
```

---

## Integration with SvelteKit

### hooks.server.ts

```typescript
import { createSessionHandler } from '@happyvertical/smrt-users/sveltekit';
import { sequence } from '@sveltejs/kit/hooks';

const sessionHandler = createSessionHandler({
  db: { type: 'postgres', url: process.env.DATABASE_URL }
});

export const handle = sequence(sessionHandler);
```

### +layout.server.ts

```typescript
export const load = async ({ locals }) => {
  return {
    user: locals.user,
    permissions: locals.permissions
  };
};
```

### +layout.svelte

```svelte
<script>
  import { Provider } from '@happyvertical/smrt-svelte';
  let { data, children } = $props();
</script>

<Provider
  user={data.user}
  permissions={data.permissions}
  ai={{ preload: 'idle', stt: { type: 'whisper-cpp' } }}
>
  {@render children()}
</Provider>
```

---

## State Architecture

```
Provider
    │
    ├── SmrtAppStateManager ($state rune)
    │   ├── mode: 'default' | 'smrt'
    │   ├── session: { user, permissions, preferences }
    │   ├── capabilities: BrowserAICapabilities
    │   ├── ai: { stt, tts, llm } (adapter states)
    │   ├── aiLoading: { phase, progress, loaded, failed }
    │   └── socket: { status, reconnectAttempts }
    │
    └── Warm Client Cache (module-level)
        ├── sttCache: Map<STTType, CachedAdapter>
        ├── ttsCache: Map<TTSType, CachedAdapter>
        └── llmCache: Map<string, CachedAdapter>
```

The warm client cache is module-level, surviving component remounts and navigation. This prevents re-downloading large WASM files and models.

---

## Dependencies

- `@happyvertical/browser-ai`: Browser AI adapters (STT, TTS, LLM)
- `@happyvertical/smrt-users`: User, Tenant, Permission types
- `@happyvertical/smrt-profiles`: Profile types
- `svelte`: ^5.18.2 (peer dependency)
