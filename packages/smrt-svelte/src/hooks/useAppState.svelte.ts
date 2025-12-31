/**
 * Hook to access app state from context
 */

import type { AppMode } from '../state/app-state.js';
import type { SmrtAppStateManager } from '../state/app-state.svelte.js';
import { getAppStateContext, tryGetAppStateContext } from '../state/context.js';

/**
 * Get the app state manager from context
 *
 * @throws If called outside of SmrtProvider
 *
 * @example
 * ```svelte
 * <script>
 *   import { useAppState } from '@happyvertical/smrt-svelte';
 *
 *   const app = useAppState();
 *
 *   // Access reactive state
 *   $: mode = app.state.mode;
 *   $: isSmrt = mode === 'smrt';
 * </script>
 * ```
 */
export function useAppState(): SmrtAppStateManager {
  return getAppStateContext();
}

/**
 * Try to get app state, returns null if not in context
 */
export function tryUseAppState(): SmrtAppStateManager | null {
  return tryGetAppStateContext();
}

/**
 * Helper to check if smrt mode is enabled
 */
export function useIsSmrt(): boolean {
  const app = getAppStateContext();
  return app.state.mode === 'smrt';
}

/**
 * Helper to get current mode
 */
export function useMode(): AppMode {
  const app = getAppStateContext();
  return app.state.mode;
}

/**
 * Helper to check permissions
 */
export function usePermissions(): {
  has: (permission: string) => boolean;
  hasAll: (permissions: string[]) => boolean;
  hasAny: (permissions: string[]) => boolean;
  list: string[];
} {
  const app = getAppStateContext();

  return {
    has: (permission: string) => app.hasPermission(permission),
    hasAll: (permissions: string[]) => app.hasAllPermissions(permissions),
    hasAny: (permissions: string[]) => app.hasAnyPermission(permissions),
    get list() {
      return app.state.session.permissions;
    },
  };
}
