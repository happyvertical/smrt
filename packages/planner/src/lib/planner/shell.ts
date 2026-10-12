import type {
  PanelEdge,
  ShellPanelDefaults,
} from '@happyvertical/smrt-svelte/workspace';

/**
 * The Planner starts with its navigation open so footer controls stay in the
 * left sidebar. Hosts embedding Planner can use the same shell defaults.
 */
export const PLANNER_SHELL_EDGE_TOGGLES: Partial<Record<PanelEdge, boolean>> = {
  left: true,
};

/** Panel defaults shared by Planner's static shell and embedding hosts. */
export const PLANNER_SHELL_PANEL_DEFAULTS: ShellPanelDefaults = {
  left: { initial: 'expanded' },
  right: { initial: 'collapsed', rail: false, presentation: 'overlay' },
  bottom: { initial: 'hidden' },
};

/** Props for an AppShell that hosts Planner. */
export function plannerShellProps() {
  return {
    edgeToggles: PLANNER_SHELL_EDGE_TOGGLES,
    config: PLANNER_SHELL_PANEL_DEFAULTS,
    hotkeys: false,
    showCompactRailBrand: false,
  };
}
