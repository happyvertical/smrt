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
