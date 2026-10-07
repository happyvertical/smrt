import { M } from '../../../i18n/strings.workspace.js';
import type { ShellRegion, ShellSlot } from './slots.js';

/** Message for each slot's full user-facing name (e.g. "Header, left"). */
export const SHELL_SLOT_MESSAGES = {
  'header.start': M['ui.shell_slot.header_start'],
  'header.center': M['ui.shell_slot.header_center'],
  'header.end': M['ui.shell_slot.header_end'],
  'footer.start': M['ui.shell_slot.footer_start'],
  'footer.center': M['ui.shell_slot.footer_center'],
  'footer.end': M['ui.shell_slot.footer_end'],
  'leftSidebar.header': M['ui.shell_slot.left_sidebar_header'],
  'leftSidebar.footer': M['ui.shell_slot.left_sidebar_footer'],
  'rightSidebar.header': M['ui.shell_slot.right_sidebar_header'],
  'rightSidebar.footer': M['ui.shell_slot.right_sidebar_footer'],
} as const satisfies Record<ShellSlot, unknown>;

/** Message for a slot's short name within its region (e.g. "Left"). */
export const SHELL_SLOT_SHORT_MESSAGES = {
  'header.start': M['ui.shell_slot.short_header_start'],
  'header.center': M['ui.shell_slot.short_header_center'],
  'header.end': M['ui.shell_slot.short_header_end'],
  'footer.start': M['ui.shell_slot.short_footer_start'],
  'footer.center': M['ui.shell_slot.short_footer_center'],
  'footer.end': M['ui.shell_slot.short_footer_end'],
  'leftSidebar.header': M['ui.shell_slot.short_sidebar_header'],
  'leftSidebar.footer': M['ui.shell_slot.short_sidebar_footer'],
  'rightSidebar.header': M['ui.shell_slot.short_sidebar_header'],
  'rightSidebar.footer': M['ui.shell_slot.short_sidebar_footer'],
} as const satisfies Record<ShellSlot, unknown>;

export const SHELL_REGION_MESSAGES = {
  header: M['ui.shell_region.header'],
  leftSidebar: M['ui.shell_region.left_sidebar'],
  rightSidebar: M['ui.shell_region.right_sidebar'],
  footer: M['ui.shell_region.footer'],
} as const satisfies Record<ShellRegion, unknown>;
