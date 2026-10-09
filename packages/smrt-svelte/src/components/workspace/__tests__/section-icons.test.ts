import { describe, expect, it } from 'vitest';
import {
  applyShellLayout,
  normalizeShellLayout,
  renameShellItem,
  renameShellSection,
  resolveShellNavModel,
  setShellSectionIcon,
} from '../admin-shell/layout.js';
import {
  isShellIconName,
  SHELL_DEFAULT_SECTION_ICON,
  SHELL_ICON_PATHS,
  SHELL_SECTION_ICONS,
} from '../admin-shell/shell-icons.js';
import type { ShellNavGroup } from '../admin-shell/types.js';

const groups: ShellNavGroup[] = [
  {
    id: 'sales',
    heading: 'Sales',
    icon: 'receipt',
    href: '/s/sales',
    items: [{ href: '/orders', label: 'Orders' }],
  },
  { id: 'misc', heading: 'Misc', items: [{ href: '/x', label: 'X' }] },
];

describe('section icons', () => {
  it('every picker icon has a path and the default is a real icon', () => {
    for (const name of SHELL_SECTION_ICONS) {
      expect(isShellIconName(name)).toBe(true);
      expect(SHELL_ICON_PATHS[name].length).toBeGreaterThan(10);
    }
    expect(isShellIconName(SHELL_DEFAULT_SECTION_ICON)).toBe(true);
    expect(isShellIconName('constructor')).toBe(false);
  });

  it('normalizes a stored icon like a label', () => {
    const layout = normalizeShellLayout({
      version: 1,
      sections: { sales: { icon: '  truck ' }, misc: { icon: '   ' } },
    });
    expect(layout.sections).toEqual({ sales: { icon: 'truck' } });
  });

  it('exposes displayed and default icons on the model', () => {
    const model = resolveShellNavModel([], groups, {
      version: 1,
      sections: { sales: { icon: 'truck' }, misc: { icon: 'wrench' } },
    });
    const byId = new Map(model.map((s) => [s.id, s]));
    expect(byId.get('sales')).toMatchObject({
      icon: 'truck',
      defaultIcon: 'receipt',
    });
    expect(byId.get('misc')).toMatchObject({
      icon: 'wrench',
      defaultIcon: null,
    });
  });

  it('sets, overrides and clears the icon; the host icon drops the override', () => {
    let layout = setShellSectionIcon([], groups, null, 'sales', 'truck');
    expect(layout.sections?.sales?.icon).toBe('truck');
    layout = setShellSectionIcon([], groups, layout, 'sales', 'receipt');
    expect(layout.sections).toBeUndefined();
    layout = setShellSectionIcon([], groups, layout, 'misc', 'wrench');
    expect(layout.sections?.misc?.icon).toBe('wrench');
    layout = setShellSectionIcon([], groups, layout, 'misc', null);
    expect(layout.sections).toBeUndefined();
    // Unknown sections are ignored.
    expect(setShellSectionIcon([], groups, layout, 'nope', 'truck')).toEqual(
      layout,
    );
  });

  it('applyShellLayout carries the icon and keeps href', () => {
    const layout = setShellSectionIcon([], groups, null, 'sales', 'truck');
    const applied = applyShellLayout([], groups, undefined, layout);
    expect(applied.groups[0]).toMatchObject({
      id: 'sales',
      icon: 'truck',
      href: '/s/sales',
    });
    expect(applied.groups[1].icon).toBeUndefined();
  });

  it('a renamed section keeps its icon and href', () => {
    const renamed = renameShellSection([], groups, null, 'sales', 'Revenue');
    const withIcon = setShellSectionIcon([], groups, renamed, 'sales', 'bank');
    const applied = applyShellLayout([], groups, undefined, withIcon);
    expect(applied.groups[0]).toMatchObject({
      heading: 'Revenue',
      icon: 'bank',
      href: '/s/sales',
    });
  });
});

describe('item description overrides', () => {
  const nav: ShellNavGroup[] = [
    {
      id: 'g',
      heading: 'G',
      items: [{ id: 'a', href: '/a', label: 'A', description: 'Host line.' }],
    },
  ];
  it('replaces the description and survives a rename round trip', () => {
    const layout = normalizeShellLayout({
      version: 1,
      items: { a: { description: ' Yoga line. ' } },
    });
    expect(layout.items).toEqual({ a: { description: 'Yoga line.' } });
    const item = resolveShellNavModel([], nav, layout)[1].items[0];
    expect(item.item.description).toBe('Yoga line.');
    const renamed = renameShellItem([], nav, layout, 'a', 'Classes');
    expect(renamed.items?.a).toEqual({
      label: 'Classes',
      description: 'Yoga line.',
    });
    const reset = renameShellItem([], nav, renamed, 'a', null);
    expect(reset.items?.a).toEqual({ description: 'Yoga line.' });
  });
});
