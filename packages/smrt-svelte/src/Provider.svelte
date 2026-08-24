<script lang="ts">
import {
  createI18nContext,
  type I18nSnapshot,
  setI18nContext,
} from '@happyvertical/smrt-ui/i18n';
import {
  type RegisterWebMcpToolsOptions,
  type SmrtWebClient,
  type SmrtWebCollectionDefinition,
} from '@happyvertical/smrt-web';
import type { Snippet } from 'svelte';
import { onDestroy, untrack } from 'svelte';
import { logger } from './internal/logger.js';
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
   * Opt in to the generated collection tools for this browser surface.
   * WebMCP is feature-detected by smrt-web, so this is safe during SSR and on
   * browsers that do not expose `document.modelContext`.
   */
  webmcp?: boolean | WebMcpProviderConfig;
  /**
   * Children to render
   */
  children: Snippet;
}

export interface WebMcpProviderConfig {
  definitions?: SmrtWebCollectionDefinition[];
  client?: SmrtWebClient;
  basePath?: string;
  fetchFn?: typeof fetch;
  scope?: string;
  filter?: RegisterWebMcpToolsOptions['filter'];
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
  webmcp,
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

// Keep generated data-plane tools scoped to this Provider. The registrar
// feature-detects WebMCP itself; effects do not run during SSR.
$effect(() => {
  if (typeof window === 'undefined' || !webmcp) return;

  const config = typeof webmcp === 'object' ? webmcp : {};
  let cancelled = false;
  let dispose = () => {};

  // Keep the data-plane engine out of applications that do not opt in. The
  // dynamic import also means SSR never evaluates browser-only engine code.
  void import('@happyvertical/smrt-web').then(({ registerWebMcpTools }) => {
    if (cancelled) return;
    dispose = registerWebMcpTools(config.definitions ?? [], {
      ...(config.client ? { client: config.client } : {}),
      ...(config.basePath ? { basePath: config.basePath } : {}),
      ...(config.fetchFn ? { fetchFn: config.fetchFn } : {}),
      ...(config.scope ? { scope: config.scope } : {}),
      ...(config.filter ? { filter: config.filter } : {}),
    });
  });

  return () => {
    cancelled = true;
    dispose();
  };
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
  // dispose() is async; isolate + log its rejection so a failing adapter
  // teardown surfaces as a logged error instead of an unhandled promise
  // rejection during Provider teardown.
  void appState.dispose().catch((error) => {
    logger.error('AppState dispose failed during Provider teardown', { error });
  });
});
</script>

{#if ai && showLoadingOverlay}
  <!-- Lazy: the overlay and its browser-ai component tree stay out of the
       initial bundle for pages that never configure AI. -->
  {#await import('./browser-ai/svelte/components/AILoadingOverlay.svelte') then m}
    <m.default
      message={ai.loadingMessage}
      dismissible={true}
    />
  {/await}
{/if}

{@render children()}
