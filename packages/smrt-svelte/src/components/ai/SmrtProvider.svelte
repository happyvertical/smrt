<script lang="ts">
import type { Snippet } from 'svelte';
import { onDestroy, untrack } from 'svelte';
import type {
  AIConfig,
  AILoadingState,
  AppMode,
  SocketConfig,
  User,
} from '../../state/app-state.js';
import { createAppState } from '../../state/app-state.svelte.js';
import { setAppStateContext } from '../../state/context.js';
import AILoadingOverlay from './AILoadingOverlay.svelte';

interface Props {
  /**
   * Initial mode: 'dumb' | 'smrt'
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
   * <SmrtProvider
   *   ai={{
   *     preload: 'idle',
   *     stt: { type: 'whisper-cpp' },
   *     showLoadingOverlay: true
   *   }}
   * >
   *   ...
   * </SmrtProvider>
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
  children,
}: Props = $props();

// Determine if we should show the loading overlay
const showLoadingOverlay = $derived(ai?.showLoadingOverlay ?? true);

// Create app state
const appState = createAppState({
  initialMode: mode,
  session: {
    preferences: {
      autoEnableSmrt,
    },
  },
  ai,
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

// Provide context
setAppStateContext(appState);

// Initialize on mount (untrack to prevent infinite loop)
$effect(() => {
  untrack(() => {
    appState.initialize();
  });
});

// Sync user and permissions when they change
$effect(() => {
  appState.setUser(user, permissions);
});

// Manage socket lifecycle
$effect(() => {
  if (socket) {
    appState.connectSocket(socket);
  }
});

// Update AI config when it changes (for dynamic config updates)
$effect(() => {
  if (ai) {
    untrack(() => {
      appState.setAIConfig(ai);
    });
  }
});

// Cleanup on destroy
onDestroy(() => {
  appState.disconnectSocket();
});
</script>

{#if ai && showLoadingOverlay}
  <AILoadingOverlay
    message={ai.loadingMessage}
    dismissible={true}
  />
{/if}

{@render children()}
