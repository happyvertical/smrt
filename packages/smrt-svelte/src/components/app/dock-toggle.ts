import type { ShellSlot } from '../workspace/admin-shell/slots.js';

/** A button that toggles one dock tool. */
export interface DockToggle {
  /** Id of the `ShellDockTool` to toggle. */
  tool: string;
  /** Accessible name and tooltip. */
  label: string;
  /**
   * Icon name. `chat` (the default for the `assistant` tool) draws a
   * chat bubble; any other text is shown as a glyph. Without an icon the
   * label's first letter stands in.
   */
  icon?: string;
  /**
   * Shell slot the button renders in. Default `header.end`. If that slot's
   * region is hidden the shell moves it along the slot fallback chain.
   */
  slot?: ShellSlot;
}
