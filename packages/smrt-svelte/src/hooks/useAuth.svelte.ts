/**
 * Hook to access authentication state
 */

import type { User } from '../state/app-state.js';
import { getAppStateContext } from '../state/context.js';

/**
 * Access authentication state and permission checking
 *
 * @example
 * ```svelte
 * <script>
 *   import { useAuth } from '@happyvertical/smrt-svelte';
 *
 *   const auth = useAuth();
 * </script>
 *
 * {#if auth.isAuthenticated}
 *   <p>Welcome, {auth.user?.email}</p>
 *
 *   {#if auth.hasPermission('articles.create')}
 *     <button>Create Article</button>
 *   {/if}
 * {:else}
 *   <a href="/login">Sign In</a>
 * {/if}
 * ```
 */
export function useAuth(): {
  /** The authenticated user (null if not authenticated) */
  readonly user: User | null;
  /** Whether a user is authenticated */
  readonly isAuthenticated: boolean;
  /** List of user's permissions */
  readonly permissions: readonly string[];
  /** Check if user has a specific permission */
  hasPermission: (permission: string) => boolean;
  /** Check if user has all of the specified permissions */
  hasAllPermissions: (permissions: string[]) => boolean;
  /** Check if user has any of the specified permissions */
  hasAnyPermission: (permissions: string[]) => boolean;
} {
  const app = getAppStateContext();

  return {
    get user() {
      return app.state.session.user;
    },
    get isAuthenticated() {
      return app.state.session.isAuthenticated;
    },
    get permissions() {
      return app.state.session.permissions;
    },
    hasPermission: (permission: string) => app.hasPermission(permission),
    hasAllPermissions: (permissions: string[]) =>
      app.hasAllPermissions(permissions),
    hasAnyPermission: (permissions: string[]) =>
      app.hasAnyPermission(permissions),
  };
}
