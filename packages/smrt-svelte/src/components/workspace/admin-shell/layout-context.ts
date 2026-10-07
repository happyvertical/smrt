import { getContext, setContext } from 'svelte';
import type { ShellLayoutController } from './layout-controller.svelte.js';

export const SHELL_LAYOUT_CONTEXT = Symbol('smrt-shell-layout');

export function setShellLayout(
  controller: ShellLayoutController,
): ShellLayoutController {
  setContext(SHELL_LAYOUT_CONTEXT, controller);
  return controller;
}

/** The layout API of the nearest `AppShell`; throws when there is none. */
export function useShellLayout(): ShellLayoutController {
  const controller = getContext<ShellLayoutController | undefined>(
    SHELL_LAYOUT_CONTEXT,
  );
  if (!controller) {
    throw new Error('[useShellLayout] No AppShell layout found on context.');
  }
  return controller;
}

export function tryUseShellLayout(): ShellLayoutController | null {
  return (
    getContext<ShellLayoutController | undefined>(SHELL_LAYOUT_CONTEXT) ?? null
  );
}
