<script lang="ts">
import {
  createI18nContext,
  type I18nSnapshot,
  setI18nContext,
} from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { onDestroy, untrack } from 'svelte';
import AILoadingOverlay from './browser-ai/svelte/components/AILoadingOverlay.svelte';
import type {
  AIConfig,
  AILoadingState,
  AppMode,
  SocketConfig,
  User,
} from './state/app-state.js';
import { createAppState } from './state/app-state.svelte.js';
import { setAppStateContext } from './state/context.js';

interface Props {
  /**
   * Initial mode: 'default' | 'smrt'
   * If not provided, mode is auto-detected based on capabilities
   */
  mode?: AppMode;
  /**
   * Whether to auto-enable smrt mode when capabilities are available
   * @default true
   */
  autoEnableSmrt?: boolean;
  /**
   * User object from smrt-users (from your load function)
   * Pass null when not authenticated
   */
  user?: User | null;
  /**
   * Resolved permissions (from PermissionResolver in your load function)
   */
  permissions?: string[];
  /**
   * WebSocket configuration
   * If provided, connects on mount and disconnects on unmount
   */
  socket?: SocketConfig;
  /**
   * AI configuration for preloading and warm clients
   *
   * @example
   * ```svelte
   * <Provider
   *   ai={{
   *     preload: 'idle',
   *     stt: { type: 'whisper-cpp' },
   *     showLoadingOverlay: true
   *   }}
   * >
   *   ...
   * </Provider>
   * ```
   */
  ai?: AIConfig;
  /**
   * Callback when capabilities are detected
   */
  onReady?: () => void;
  /**
   * Callback when mode changes
   */
  onModeChange?: (mode: AppMode) => void;
  /**
   * Callback when AI loading state changes
   */
  onAILoadingChange?: (state: AILoadingState) => void;
  /**
   * i18n snapshot from your load function (`buildI18nSnapshot` on
   * `@happyvertical/smrt-svelte/i18n/server`). Provides the active locale +
   * resolved message templates to `useI18n()` / `<Trans>`. Omit for
   * English-default-only rendering.
   */
  i18n?: I18nSnapshot;
  /**
   * Children to render
   */
  children: Snippet;
}

const {
  mode,
  autoEnableSmrt = true,
  user = null,
  permissions = [],
  socket,
  ai,
  onReady,
  onModeChange,
  onAILoadingChange,
  i18n,
  children,
}: Props = $props();

// Determine if we should show the loading overlay
const showLoadingOverlay = $derived(ai?.showLoadingOverlay ?? true);

// Create app state
const appState = createAppState({
  onCapabilitiesDetected: () => {
    onReady?.();
  },
  onModeChange: (newMode) => {
    onModeChange?.(newMode);
  },
  onAILoadingChange: (state) => {
    onAILoadingChange?.(state);
  },
});

$effect(() => {
  const currentPreferences = untrack(() => appState.state.session.preferences);
  if (currentPreferences.autoEnableSmrt === autoEnableSmrt) {
    return;
  }

  appState.updateSession({
    preferences: {
      ...currentPreferences,
      autoEnableSmrt,
    },
  });
});

$effect(() => {
  if (mode) {
    appState.setMode(mode, 'explicit');
  }
});

// Provide context
setAppStateContext(appState);

// i18n: seed the store from the initial snapshot synchronously (untrack — this
// MUST run during SSR, where $effect does not, so translated strings render on
// the server), then keep it in sync when the `i18n` prop changes (locale
// switch). Reads stay synchronous on the client; all async resolution happened
// server-side in buildI18nSnapshot.
const i18nStore = untrack(() => createI18nContext(i18n));
setI18nContext(i18nStore);
$effect(() => {
  if (i18n) {
    i18nStore.snapshot = i18n;
  }
});

// Initialize on mount (untrack to prevent infinite loop)
// Skip during SSR - browser-ai APIs require browser environment
$effect(() => {
  if (typeof window === 'undefined') return;
  untrack(() => {
    appState.initialize();
  });
});

// Sync user and permissions when they change
$effect(() => {
  appState.setUser(user, permissions);
});

// Manage socket lifecycle (browser-only)
$effect(() => {
  if (typeof window === 'undefined') return;
  if (socket) {
    // connectSocket already handles disconnecting any existing socket
    appState.connectSocket(socket);

    // Cleanup when socket prop changes or component unmounts
    return () => {
      appState.disconnectSocket();
    };
  }
});

// Update AI config when it changes (for dynamic config updates, browser-only)
$effect(() => {
  if (typeof window === 'undefined') return;
  if (ai) {
    untrack(() => {
      appState.setAIConfig(ai);
    });
  }
});

// Cleanup on destroy. Dispose the whole manager (not just the socket) so it
// unsubscribes its listeners from the module-surviving warm AI adapters; left
// attached, each destroyed Provider would keep pinning its `_state` proxy via
// those adapters' listener `Set`s and leak one set per navigation (R1). The
// warm cache itself survives — dispose() leaves cached adapters intact.
onDestroy(() => {
  appState.dispose();
});
</script>

{#if ai && showLoadingOverlay}
  <AILoadingOverlay
    message={ai.loadingMessage}
    dismissible={true}
  />
{/if}

{@render children()}
