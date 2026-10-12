import type { Snippet } from 'svelte';
import type { PaletteProvider } from '../command-palette/types.js';
import type { ShellSlot } from '../workspace/admin-shell/slots.js';

/**
 * A host item that lives in a shell slot and that users can move to another
 * slot from the layout editor (`ShellLayout.placements`). Prefer this over the
 * `slots` prop when the content should be individually movable.
 */
export interface ShellSlotItem {
  /**
   * Stable id; keep it unchanged across releases because a stored layout
   * refers to it. Must not collide with `dock:` or `slot:` ids.
   */
  id: string;
  /** Accessible, user-facing name shown in the layout editor. */
  label: string;
  /** Default slot; a user's layout can move it elsewhere. */
  slot: ShellSlot;
  /** The content. */
  render: Snippet;
}

/**
 * `AppShell` `accountMenu`: `false` opts out of the built-in `item:account`;
 * `{ slot }` sets its default slot (default `leftSidebar.footer`, the end of
 * the header band on phones).
 */
export type AppShellAccountMenu = boolean | { slot?: ShellSlot };

/** `AppShell` `commandPalette`: the built-in `item:command-palette`. */
export interface AppShellCommandPalette {
  /** Providers for the palette (navigation, records, commands). */
  providers: PaletteProvider[];
  /** Search box placeholder in the palette dialog. */
  placeholder?: string;
}
