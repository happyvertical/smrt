import { getContext, setContext } from 'svelte';
import type { ShellState } from './state.svelte.js';

export const ADMIN_SHELL_CONTEXT = Symbol('smrt-admin-shell');

export function setAdminShell(shell: ShellState): ShellState {
  setContext(ADMIN_SHELL_CONTEXT, shell);
  return shell;
}

export function useAdminShell(): ShellState {
  const shell = getContext<ShellState | undefined>(ADMIN_SHELL_CONTEXT);
  if (!shell) {
    throw new Error(
      '[useAdminShell] No AdminShell state found on Svelte context.',
    );
  }
  return shell;
}

export function tryUseAdminShell(): ShellState | null {
  return getContext<ShellState | undefined>(ADMIN_SHELL_CONTEXT) ?? null;
}
