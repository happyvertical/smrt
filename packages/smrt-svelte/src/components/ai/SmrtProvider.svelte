<script lang="ts">
import type { Snippet } from 'svelte';
import { untrack } from 'svelte';
import type { AppMode, CreateAppStateOptions } from '../../state/app-state.js';
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
</script>

{@render children()}
