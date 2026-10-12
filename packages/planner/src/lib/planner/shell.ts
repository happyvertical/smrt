import type {
  PanelEdge,
  ShellPanelDefaults,
} from '@happyvertical/smrt-svelte/workspace';

/**
 * The static Planner starts with navigation out of the way, while retaining a
 * native control that can reopen it. Hosts embedding Planner in an AppShell
 * can use these same defaults instead of overriding shell CSS.
 */
export const PLANNER_SHELL_EDGE_TOGGLES: Partial<Record<PanelEdge, boolean>> = {
  left: true,
};

/** Panel defaults shared by Planner's static shell and embedding hosts. */
export const PLANNER_SHELL_PANEL_DEFAULTS: ShellPanelDefaults = {
  left: { initial: 'collapsed' },
  right: { initial: 'collapsed', rail: false, presentation: 'overlay' },
};

/** Props for an AppShell that hosts Planner. */
export function plannerShellProps() {
  return {
    edgeToggles: PLANNER_SHELL_EDGE_TOGGLES,
    config: PLANNER_SHELL_PANEL_DEFAULTS,
  };
}
