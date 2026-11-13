import type { Snippet } from 'svelte';
import type { PaletteProvider } from '../command-palette/types.js';
import type { ShellIconName } from '../workspace/admin-shell/shell-icons.js';
import type { ShellSlot } from '../workspace/admin-shell/slots.js';
import type { WorkspaceAccountMenuItem } from '../workspace/admin-shell/types.js';

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
  /**
   * Keep the item in the collapsed left rail. Only for `leftSidebar.footer`
   * items that stay usable as a compact icon-only control: the collapsed rail
   * then shows it above the account avatar instead of letting the footer slot
   * fall back to another region. Default false.
   */
  rail?: boolean;
}

/**
 * `AppShell` `accountMenu`: `false` opts out of the built-in `item:account`;
 * `{ slot }` sets its default slot (default `leftSidebar.footer`, the end of
 * the header band on phones).
 */
export type AppShellAccountMenu =
  | boolean
  | {
      slot?: ShellSlot;
      /**
       * Host destinations or actions (caller-owned, e.g. Approvals and
       * History) shown before Settings; positive badges also show on the
       * closed trigger.
       */
      items?: WorkspaceAccountMenuItem[];
      /** Add a Theme item that switches light and dark (default false). */
      theme?: boolean;
    };

/**
 * `AppShell` `panelToggle`: the built-in `item:panel-toggle`, an icon button
 * (`aria-pressed`) that shows and hides the docked `panel`. Default slot
 * `leftSidebar.footer`; it stays in the collapsed rail and, on phones with the
 * tab bar, becomes a tab.
 */
export interface AppShellPanelToggle {
  /** Accessible name and tooltip. */
  label: string;
  /** Shell icon (default `chat`). */
  icon?: ShellIconName;
  /** Default slot (default `leftSidebar.footer`). */
  slot?: ShellSlot;
}

/** `AppShell` `commandPalette`: the built-in `item:command-palette`. */
export interface AppShellCommandPalette {
  /** Providers for the palette (navigation, records, commands). */
  providers: PaletteProvider[];
  /** Search box placeholder in the palette dialog. */
  placeholder?: string;
}

/**
 * `AppShell` `voiceToggle`: the built-in `item:voice`, an icon button for a
 * voice mode (speech in and out) in the footer of the left sidebar, above the
 * panel toggle. The shell only draws the control; the host owns what voice
 * does and passes its state.
 */
export interface AppShellVoiceToggle {
  /** Accessible name while voice is available (e.g. "Voice mode"). */
  label: string;
  /**
   * `off` and `on` are a toggle (`aria-pressed`, `onpress` flips it).
   * `unavailable` is a dimmed `aria-disabled` control without a pressed state,
   * still focusable so its reason can be read; it never calls `onpress`.
   */
  state: 'off' | 'on' | 'unavailable';
  /** Tooltip and accessible name while `unavailable` (why it cannot be used). */
  unavailableLabel?: string;
  /** Called when a toggle (`off`/`on`) is pressed. */
  onpress?: () => void;
  /** Default slot (default `leftSidebar.footer`). */
  slot?: ShellSlot;
}
