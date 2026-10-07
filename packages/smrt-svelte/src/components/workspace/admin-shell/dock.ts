import { useAdminShell } from './context.js';
import type { ShellDockOpenOptions } from './types.js';

/**
 * Programmatic control of the shell dock (the right edge and the focus tools
 * registered in it with `ShellDockTool`). Tool ids are the `ShellDockTool`
 * ids. All reads are reactive.
 */
export interface ShellDock {
  /** Id of the tool shown in the open dock, or `null` when it is closed. */
  readonly active: string | null;
  /** Ids of the registered dock tools. */
  readonly tools: readonly string[];
  /**
   * Whether the dock can be shown at all: false when the host removed the
   * right edge or the user's layout hides it (opening then does nothing).
   */
  readonly available: boolean;
  /** Whether `tool` is registered as a dock tool. */
  has(tool: string): boolean;
  /** Whether the dock is open on `tool`. */
  isOpen(tool: string): boolean;
  /**
   * Open the dock on `tool` and move focus into it. Returns false (and does
   * nothing) when no such tool is registered or the dock is not `available`.
   */
  open(tool: string, options?: ShellDockOpenOptions): boolean;
  /** Close the dock; focus returns to where it was opened from. */
  close(): void;
  /** Open `tool`, or close the dock when it is already open on `tool`. */
  toggle(tool: string, options?: ShellDockOpenOptions): boolean;
}

/**
 * Dock control for the surrounding `AdminShell` / `AppShell`. Call it during
 * component initialisation inside the shell (for example from the `dock`
 * snippet, a route, or an assistant); it throws outside a shell.
 */
export function useShellDock(): ShellDock {
  const shell = useAdminShell();
  return {
    get active() {
      return shell.openFocusToolId;
    },
    get tools() {
      return shell.focusTools.map((tool) => tool.id);
    },
    get available() {
      return shell.dockAvailable;
    },
    has: (tool) => shell.focusTools.some((t) => t.id === tool),
    isOpen: (tool) => shell.openFocusToolId === tool,
    open: (tool, options) => shell.openDockTool(tool, options),
    close: () => shell.closeFocusTool(),
    toggle: (tool, options) => shell.toggleDockTool(tool, options),
  };
}
