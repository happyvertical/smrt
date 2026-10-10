import type { Snippet } from 'svelte';
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
