/**
 * LibraryCookbook icons as Tabler-style stroke paths (24x24 viewBox, `currentColor`,
 * stroke width 2, round caps). The planner has no icon library; these few are
 * inline so the cookbook data names an icon instead of carrying markup.
 */
export const COOKBOOK_ICONS: Record<string, readonly string[]> = {
  bread: [
    'M7 3h10a4 4 0 0 1 2.4 7.2L20 19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2l.6-8.8A4 4 0 0 1 7 3z',
    'M9 13l1 3',
    'M14 13l1 3',
  ],
  car: [
    'M5 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    'M15 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    'M5 17h-2v-6l2-5h9l4 5h1a2 2 0 0 1 2 2v4h-2m-4 0h-6m-6-6h15m-6 0v-5',
  ],
  flame: [
    'M12 12c2-2.96 0-7-1-8 0 3.038-1.773 4.741-3 6-1.226 1.26-2 3.24-2 5a6 6 0 1 0 12 0c0-1.532-1.056-3.94-2-5-1.786 3-2.791 3-4 2z',
  ],
  yoga: [
    'M11 4a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
    'M4 20h4l1.5-3',
    'M17 20l-1-5h-5l1-7',
    'M4 10l4-1l4-1l4 1.5l4 1.5',
  ],
};
