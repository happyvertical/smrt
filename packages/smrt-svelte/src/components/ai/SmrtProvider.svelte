<script lang="ts">
import type { Snippet } from 'svelte';
import { onDestroy, untrack } from 'svelte';
import type { AppMode, SocketConfig, User } from '../../state/app-state.js';
import { createAppState } from '../../state/app-state.svelte.js';
import { setAppStateContext } from '../../state/context.js';

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
   * Callback when capabilities are detected
   */
  onReady?: () => void;
  /**
   * Callback when mode changes
   */
  onModeChange?: (mode: AppMode) => void;
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
  onReady,
  onModeChange,
  children,
}: Props = $props();

// Create app state
const appState = createAppState({
  initialMode: mode,
  session: {
    preferences: {
      autoEnableSmrt,
    },
  },
  onCapabilitiesDetected: () => {
    onReady?.();
  },
  onModeChange: (newMode) => {
    onModeChange?.(newMode);
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

// Cleanup on destroy
onDestroy(() => {
  appState.disconnectSocket();
});
</script>

{@render children()}
