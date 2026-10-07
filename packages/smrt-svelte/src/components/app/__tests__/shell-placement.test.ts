import { describe, expect, it } from 'vitest';
import {
  applyShellLayout,
  isShellLayoutEmpty,
  normalizeShellLayout,
  placeShellItem,
  resetShellItemPlacement,
  resolveShellPlacements,
  resolveShellVisiblePlacements,
  type ShellLayout,
} from '../../workspace/admin-shell/layout.js';
import type { ShellPlacementItem } from '../../workspace/admin-shell/slots.js';

const items: ShellPlacementItem[] = [
  { id: 'slot:header.end', label: 'Header right content', slot: 'header.end' },
  { id: 'dock:assistant', label: 'Assistant', slot: 'header.end' },
  { id: 'dock:notes', label: 'Notes', slot: 'footer.start' },
];
const empty: ShellLayout = { version: 1 };

describe('shell item placements', () => {
  it('uses default slots for layouts without placements (back-compat)', () => {
    const placed = resolveShellPlacements(items, empty);
    expect(placed['header.end']).toEqual(['slot:header.end', 'dock:assistant']);
    expect(placed['footer.start']).toEqual(['dock:notes']);
    expect(resolveShellPlacements(items, null)).toEqual(placed);
    expect(isShellLayoutEmpty({ version: 1, placements: {} })).toBe(true);
    // A version-1 layout without placements is unchanged by applying it.
    const nav = [{ href: '/', label: 'Home' }];
    expect(applyShellLayout(nav, [], undefined, empty).nav).toBe(nav);
  });

  it('moves an item: default order first, then placement order', () => {
    const layout = placeShellItem(empty, 'dock:notes', 'header.end');
    expect(layout).toEqual({
      version: 1,
      placements: { 'dock:notes': 'header.end' },
    });
    const placed = resolveShellPlacements(items, layout);
    expect(placed['header.end']).toEqual([
      'slot:header.end',
      'dock:assistant',
      'dock:notes',
    ]);
    expect(placed['footer.start']).toEqual([]);
    const again = placeShellItem(layout, 'dock:assistant', 'header.end');
    expect(Object.keys(again.placements ?? {})).toEqual([
      'dock:notes',
      'dock:assistant',
    ]);
  });

  it('keeps the layout sparse and ignores unknown ids and slots', () => {
    const moved = placeShellItem(
      empty,
      'dock:assistant',
      'footer.end',
      'header.end',
    );
    expect(
      placeShellItem(moved, 'dock:assistant', 'header.end', 'header.end'),
    ).toEqual(empty);
    expect(placeShellItem(empty, 'dock:assistant', 'nowhere' as never)).toEqual(
      empty,
    );
    const placed = resolveShellPlacements(items, {
      version: 1,
      placements: { 'dock:gone': 'footer.end', 'dock:notes': 'footer.end' },
    });
    expect(placed['footer.end']).toEqual(['dock:notes']);
    expect(Object.values(placed).flat().sort()).toEqual(
      items.map((item) => item.id).sort(),
    );
  });

  it('resets one item without touching others', () => {
    let layout = placeShellItem(empty, 'dock:assistant', 'footer.end');
    layout = placeShellItem(layout, 'dock:notes', 'header.start');
    layout = resetShellItemPlacement(layout, 'dock:assistant');
    expect(layout.placements).toEqual({ 'dock:notes': 'header.start' });
    expect(resetShellItemPlacement(layout, 'unknown')).toEqual(layout);
    expect(resetShellItemPlacement(layout, 'dock:notes')).toEqual(empty);
  });

  it('normalizes untrusted placements', () => {
    const layout = normalizeShellLayout({
      version: 1,
      placements: {
        'dock:a': 'header.start',
        'dock:b': 'bogus',
        'dock:c': 7,
        '': 'header.end',
      },
    });
    expect(layout.placements).toEqual({ 'dock:a': 'header.start' });
    expect(normalizeShellLayout({ version: 1, placements: [] })).toEqual(empty);
  });

  it('applies placement before the hidden-region fallback', () => {
    const layout = placeShellItem(empty, 'dock:notes', 'leftSidebar.footer');
    const onlyHeader = (region: string) => region === 'header';
    const placed = resolveShellVisiblePlacements(items, layout, onlyHeader);
    // leftSidebar.footer falls back to header.start; header.end is visible.
    expect(placed['header.start']).toEqual(['dock:notes']);
    expect(placed['header.end']).toEqual(['slot:header.end', 'dock:assistant']);
    expect(placed['leftSidebar.footer']).toEqual([]);
    // Without the placement the default footer slot falls back to the header.
    const base = resolveShellVisiblePlacements(items, empty, onlyHeader);
    expect(base['header.start']).toEqual(['dock:notes']);
    // Nothing visible: items are dropped rather than invented a slot.
    const none = resolveShellVisiblePlacements(items, layout, () => false);
    expect(Object.values(none).flat()).toEqual([]);
    // Placing into a visible slot beats the item's hidden default.
    const rescued = resolveShellVisiblePlacements(
      items,
      placeShellItem(empty, 'dock:notes', 'header.center'),
      onlyHeader,
    );
    expect(rescued['header.center']).toEqual(['dock:notes']);
  });
});
