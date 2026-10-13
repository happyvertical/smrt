import type { ShellSlot } from '../workspace/admin-shell/slots.js';

/** A button that toggles one dock tool. */
export interface DockToggle {
  /** Id of the `ShellDockTool` to toggle. */
  tool: string;
  /** Accessible name and tooltip. */
  label: string;
  /**
   * Icon name. `chat` (the default for the `assistant` tool) draws a
   * chat bubble, a shell icon name (`SHELL_ICON_PATHS`) draws that icon, and
   * any other text is shown as a glyph. Without an icon a generic tool icon
   * stands in, never the label's first letter.
   */
  icon?: string;
  /**
   * Shell slot the button renders in. Default `header.end`. If that slot's
   * region is hidden the shell moves it along the slot fallback chain.
   */
  slot?: ShellSlot;
  /**
   * Where to go when the toggle cannot toggle the dock: the tool is not
   * registered with `useShellDock()`, or `ready` is `false`. The button then
   * renders as a link (so middle-click and open-in-new-tab work) and drops
   * `aria-pressed` / `aria-expanded`. Without it that state stays inert.
   */
  href?: string;
  /**
   * Whether the tool is usable right now (default `true`). Reactive: a host
   * passes e.g. `aiState.assistantReady`. While `false` the toggle behaves as
   * the unregistered state: `href` if given, else inert.
   */
  ready?: boolean;
  /** Accessible name and tooltip in the not-ready state. Default "Set up {label}". */
  labelNotReady?: string;
  /**
   * Called first on activation with the click event and the resolved state.
   * Returning `false`, or calling `event.preventDefault()`, stops everything
   * else (no dock toggle, no navigation).
   */
  onpress?: (
    event: MouseEvent,
    state: { registered: boolean; ready: boolean },
  ) => boolean | void;
}

/** What activating a `DockToggle` does, from the live dock and `ready`. */
export type DockToggleMode = 'toggle' | 'link' | 'inert';

export interface DockToggleResolution {
  mode: DockToggleMode;
  registered: boolean;
  ready: boolean;
  /** True in the not-ready state (unregistered with an `href`, or `ready === false`). */
  notReady: boolean;
}

/**
 * Precedence: `onpress` runs first and can cancel. Then, when the tool is
 * registered and `ready !== false`, the dock toggles. Otherwise `href` is
 * followed when given, else nothing happens.
 */
export function resolveDockToggle(
  toggle: DockToggle,
  registered: boolean,
): DockToggleResolution {
  const ready = toggle.ready !== false;
  const mode: DockToggleMode =
    registered && ready ? 'toggle' : toggle.href ? 'link' : 'inert';
  return { mode, registered, ready, notReady: !ready || mode === 'link' };
}

/**
 * Run `onpress` for a click. Returns `true` when the rest of the press (dock
 * toggle or navigation) should go ahead. Stopping also calls
 * `event.preventDefault()` so a link does not navigate.
 */
export function runDockTogglePress(
  toggle: DockToggle,
  event: MouseEvent,
  resolution: DockToggleResolution,
): boolean {
  const result = toggle.onpress?.(event, {
    registered: resolution.registered,
    ready: resolution.ready,
  });
  if (result === false || event.defaultPrevented) {
    event.preventDefault();
    return false;
  }
  return true;
}
