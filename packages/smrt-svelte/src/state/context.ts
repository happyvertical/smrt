/**
 * Svelte context helpers for app state
 */

import { getContext, setContext } from 'svelte';
import type { SmrtAppStateManager } from './app-state.svelte.js';

/**
 * Context key for app state
 */
export const APP_STATE_KEY = Symbol('smrt-app-state');

/**
 * Set app state in context (used by SmrtProvider)
 */
export function setAppStateContext(state: SmrtAppStateManager): void {
  setContext(APP_STATE_KEY, state);
}

/**
 * Get app state from context
 * @throws If called outside of SmrtProvider
 */
export function getAppStateContext(): SmrtAppStateManager {
  const state = getContext<SmrtAppStateManager>(APP_STATE_KEY);

  if (!state) {
    throw new Error(
      'App state not found. Make sure to wrap your app with <SmrtProvider>',
    );
  }

  return state;
}

/**
 * Try to get app state from context
 * Returns null if not available (doesn't throw)
 */
export function tryGetAppStateContext(): SmrtAppStateManager | null {
  return getContext<SmrtAppStateManager>(APP_STATE_KEY) ?? null;
}
