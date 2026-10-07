/**
 * Shell regions and slots.
 *
 * Regions are the four edges: header (top), left sidebar, right sidebar and
 * footer (bottom). Header and footer have `start | center | end` slots;
 * sidebars have `header | footer` slots around their main area.
 */
export type ShellSlot =
  | 'header.start'
  | 'header.center'
  | 'header.end'
  | 'footer.start'
  | 'footer.center'
  | 'footer.end'
  | 'leftSidebar.header'
  | 'leftSidebar.footer'
  | 'rightSidebar.header'
  | 'rightSidebar.footer';

export const SHELL_SLOTS: readonly ShellSlot[] = [
  'header.start',
  'header.center',
  'header.end',
  'footer.start',
  'footer.center',
  'footer.end',
  'leftSidebar.header',
  'leftSidebar.footer',
  'rightSidebar.header',
  'rightSidebar.footer',
];

/** The region a slot lives in. */
export type ShellRegion = 'header' | 'footer' | 'leftSidebar' | 'rightSidebar';

export function slotRegion(slot: ShellSlot): ShellRegion {
  return slot.split('.')[0] as ShellRegion;
}

/**
 * Fallback chain used when a slot's region is not visible (hidden, or a
 * sidebar that is collapsed). The first visible slot wins; nothing is
 * dropped and no extra row is ever created.
 *
 * - header.X      -> leftSidebar.header, rightSidebar.header, footer.X
 * - footer.X      -> leftSidebar.footer, rightSidebar.footer, header.X
 * - leftSidebar.header  -> header.start, rightSidebar.header, footer.start
 * - leftSidebar.footer  -> footer.start, header.start, rightSidebar.footer
 * - rightSidebar.header -> header.end, leftSidebar.header, footer.end
 * - rightSidebar.footer -> footer.end, header.end, leftSidebar.footer
 */
export function slotFallbackChain(slot: ShellSlot): ShellSlot[] {
  const [region, part] = slot.split('.') as [ShellRegion, string];
  switch (region) {
    case 'header':
      return [
        'leftSidebar.header',
        'rightSidebar.header',
        `footer.${part}` as ShellSlot,
      ];
    case 'footer':
      return [
        'leftSidebar.footer',
        'rightSidebar.footer',
        `header.${part}` as ShellSlot,
      ];
    case 'leftSidebar':
      return part === 'header'
        ? ['header.start', 'rightSidebar.header', 'footer.start']
        : ['footer.start', 'header.start', 'rightSidebar.footer'];
    case 'rightSidebar':
      return part === 'header'
        ? ['header.end', 'leftSidebar.header', 'footer.end']
        : ['footer.end', 'header.end', 'leftSidebar.footer'];
  }
}

/** First slot in `[slot, ...fallbacks]` whose region is visible. */
export function resolveSlot(
  slot: ShellSlot,
  visible: (region: ShellRegion) => boolean,
): ShellSlot | null {
  for (const candidate of [slot, ...slotFallbackChain(slot)]) {
    if (visible(slotRegion(candidate))) return candidate;
  }
  return null;
}

/** Prefix of the stable id of a dock toggle item: `dock:<tool>`. */
export const SHELL_DOCK_ITEM_PREFIX = 'dock:';

/** Prefix of the stable id of a host `slots` snippet item: `slot:<slot>`. */
export const SHELL_HOST_SLOT_ITEM_PREFIX = 'slot:';

/** Stable item id of the dock toggle for `tool`. */
export function shellDockItemId(tool: string): string {
  return `${SHELL_DOCK_ITEM_PREFIX}${tool}`;
}

/** Stable item id of the host's `slots[slot]` snippet. */
export function shellHostSlotItemId(slot: ShellSlot): string {
  return `${SHELL_HOST_SLOT_ITEM_PREFIX}${slot}`;
}

/** Whether a value is a known {@link ShellSlot}. */
export function isShellSlot(value: unknown): value is ShellSlot {
  return (
    typeof value === 'string' &&
    (SHELL_SLOTS as readonly string[]).includes(value)
  );
}

/**
 * An item that lives in a slot and can be moved to another one. `slot` is the
 * default placement; a user's `ShellLayout.placements` overrides it.
 */
export interface ShellPlacementItem {
  /** Stable id, e.g. `dock:assistant`, `slot:header.end`, or a host id. */
  id: string;
  /** Accessible, user-facing name. */
  label: string;
  /** Where the item lives unless the layout moves it. */
  slot: ShellSlot;
}
