import { getContext, setContext } from 'svelte';

const HOSTED_THEME = Symbol('smrt-planner.hosted-theme');

/**
 * Called from the planner's root, above the shell's own `ThemeProvider`:
 * records whether a host's provider already surrounds the planner. A nested
 * provider on `system` follows that host's resolved scheme, not the device.
 */
export function provideHostedTheme(hosted: boolean): void {
  setContext(HOSTED_THEME, hosted);
}

/** True when the planner is mounted inside a host's theme provider. */
export function useHostedTheme(): boolean {
  return getContext<boolean | undefined>(HOSTED_THEME) ?? false;
}

/** The Theme tab's Auto helper text, truthful for where the planner runs. */
export function autoSchemeHint(hosted: boolean): string {
  return hosted ? 'Match the surrounding app' : 'Follow this device';
}
