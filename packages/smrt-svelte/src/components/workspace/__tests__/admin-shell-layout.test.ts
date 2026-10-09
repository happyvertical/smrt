import { describe, expect, it } from 'vitest';
import {
  applyShellLayout,
  createShellLayout,
  createShellSection,
  deleteShellSection,
  hideShellEntry,
  isShellLayoutEmpty,
  moveShellItem,
  moveShellSection,
  normalizeShellLayout,
  renameShellItem,
  renameShellSection,
  resolveShellNavModel,
  SHELL_NAV_ROOT_SECTION_ID,
  type ShellLayout,
  setShellLayoutPanel,
  setShellSectionTitleVisible,
  showShellEntry,
} from '../admin-shell/layout.js';
import { pruneShellSettingsDelta } from '../admin-shell/settings.js';
import type { ShellNavGroup, ShellNavItem } from '../admin-shell/types.js';

const nav: ShellNavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/inbox', label: 'Inbox' },
];
const groups: ShellNavGroup[] = [
  {
    heading: 'Content',
    items: [
      { href: '/posts', label: 'Posts' },
      { href: '/pages', label: 'Pages' },
      { href: '/media', label: 'Media' },
    ],
  },
  {
    heading: 'People',
    items: [
      { href: '/users', label: 'Users' },
      { href: '/roles', label: 'Roles' },
    ],
  },
  {
    id: 'ops',
    heading: 'Operations',
    items: [{ href: '/jobs', label: 'Jobs' }],
  },
];

const layout = (patch: Partial<ShellLayout>): ShellLayout => ({
  version: 1,
  ...patch,
});
const hrefs = (items: ShellNavItem[]) => items.map((item) => item.href);
const headings = (list: ShellNavGroup[]) => list.map((group) => group.heading);

describe('applyShellLayout', () => {
  it('returns the inputs unchanged for a missing or empty layout', () => {
    for (const empty of [undefined, null, layout({})]) {
      const result = applyShellLayout(nav, groups, { top: false }, empty);
      expect(result.nav).toBe(nav);
      expect(result.groups).toBe(groups);
      expect(result.panels).toEqual({ top: false });
    }
  });

  it('reorders sections and items', () => {
    const result = applyShellLayout(
      nav,
      groups,
      {},
      layout({
        sectionOrder: ['ops', 'People', 'Content'],
        itemOrder: { Content: ['/media', '/posts', '/pages'] },
      }),
    );
    expect(headings(result.groups)).toEqual([
      'Operations',
      'People',
      'Content',
    ]);
    expect(hrefs(result.groups[2].items)).toEqual([
      '/media',
      '/posts',
      '/pages',
    ]);
  });

  it('hides items and sections, dropping sections the layout empties', () => {
    const result = applyShellLayout(
      nav,
      groups,
      {},
      layout({ hidden: ['/inbox', 'People', '/jobs'] }),
    );
    expect(hrefs(result.nav)).toEqual(['/']);
    // People hidden whole; Operations emptied by hiding its only item.
    expect(headings(result.groups)).toEqual(['Content']);
  });

  it('drops a hidden section even when the host left it empty', () => {
    const result = applyShellLayout(
      [],
      [{ heading: 'Empty', items: [] }],
      {},
      layout({ hidden: ['Empty'] }),
    );
    expect(result.groups).toEqual([]);
  });

  it('keeps a section the host itself left empty', () => {
    const result = applyShellLayout(
      [],
      [{ heading: 'Empty', items: [] }],
      {},
      layout({ hidden: ['/x'] }),
    );
    expect(headings(result.groups)).toEqual(['Empty']);
  });

  it('moves items across sections, including to and from the root', () => {
    const result = applyShellLayout(
      nav,
      groups,
      {},
      layout({
        moved: {
          '/roles': 'Content',
          '/inbox': 'People',
          '/media': SHELL_NAV_ROOT_SECTION_ID,
        },
      }),
    );
    expect(hrefs(result.nav)).toEqual(['/', '/media']);
    expect(hrefs(result.groups[0].items)).toEqual([
      '/posts',
      '/pages',
      '/roles',
    ]);
    expect(hrefs(result.groups[1].items)).toEqual(['/users', '/inbox']);
  });

  it('orders moved-in items with itemOrder and hides them with their section', () => {
    const result = applyShellLayout(
      nav,
      groups,
      {},
      layout({
        moved: { '/roles': 'Content' },
        itemOrder: { Content: ['/roles', '/posts'] },
        hidden: ['People'],
      }),
    );
    // Listed ids permute among the slots they occupy; /pages keeps its slot.
    expect(hrefs(result.groups[0].items)).toEqual([
      '/roles',
      '/pages',
      '/media',
      '/posts',
    ]);
    expect(headings(result.groups)).toEqual(['Content', 'Operations']);
  });

  it('ignores ids that no longer exist', () => {
    const result = applyShellLayout(
      nav,
      groups,
      {},
      layout({
        sectionOrder: ['Gone', 'People', 'Content'],
        itemOrder: { Content: ['/removed', '/media'], Gone: ['/x'] },
        hidden: ['/removed', 'Vanished'],
        moved: { '/removed': 'Content', '/users': 'Gone' },
      }),
    );
    expect(headings(result.groups)).toEqual([
      'People',
      'Content',
      'Operations',
    ]);
    // /users stays: its target section does not exist.
    expect(hrefs(result.groups[0].items)).toEqual(['/users', '/roles']);
    expect(hrefs(result.groups[1].items)).toEqual([
      '/posts',
      '/pages',
      '/media',
    ]);
  });

  it('places items and sections the host adds later at their default slots', () => {
    const saved = layout({
      sectionOrder: ['People', 'Content'],
      itemOrder: { Content: ['/media', '/posts'] },
    });
    const grown: ShellNavGroup[] = [
      { heading: 'New', items: [{ href: '/new', label: 'New' }] },
      {
        ...groups[0],
        items: [
          { href: '/posts', label: 'Posts' },
          { href: '/fresh', label: 'Fresh' },
          { href: '/media', label: 'Media' },
        ],
      },
      groups[1],
    ];
    const result = applyShellLayout([], grown, {}, saved);
    expect(headings(result.groups)).toEqual(['New', 'People', 'Content']);
    expect(hrefs(result.groups[2].items)).toEqual([
      '/media',
      '/fresh',
      '/posts',
    ]);
  });

  it('honors explicit ids over headings and hrefs', () => {
    const items: ShellNavItem[] = [
      { id: 'a', href: '/same', label: 'A' },
      { id: 'b', href: '/same', label: 'B' },
    ];
    const result = applyShellLayout(items, [], {}, layout({ hidden: ['a'] }));
    expect(result.nav.map((item) => item.label)).toEqual(['B']);
  });

  it('disambiguates duplicate ids deterministically', () => {
    const dup: ShellNavItem[] = [
      { href: '/same', label: 'First' },
      { href: '/same', label: 'Second' },
    ];
    const ids = resolveShellNavModel(dup)[0].items.map((entry) => entry.id);
    expect(ids).toEqual(['/same', '/same#2']);
    const result = applyShellLayout(
      dup,
      [],
      {},
      layout({ hidden: ['/same#2'] }),
    );
    expect(result.nav.map((item) => item.label)).toEqual(['First']);
  });

  it('does not mutate its inputs and keeps group extras and children', () => {
    const items: ShellNavItem[] = [
      { href: '/p', label: 'P', children: [{ href: '/p/c', label: 'C' }] },
    ];
    const grp: ShellNavGroup[] = [{ id: 'g', heading: 'G', items }];
    const snapshot = JSON.stringify([items, grp]);
    const result = applyShellLayout([], grp, {}, layout({ hidden: ['x'] }));
    expect(JSON.stringify([items, grp])).toBe(snapshot);
    expect(result.groups[0].id).toBe('g');
    expect(result.groups[0].items[0].children).toHaveLength(1);
  });

  it('applies panel visibility and start state over host defaults', () => {
    const result = applyShellLayout(
      [],
      [],
      { left: { initial: 'collapsed', label: 'Nav' }, right: false, top: {} },
      layout({
        panels: {
          left: { initial: 'expanded' },
          bottom: { visible: false },
          top: { visible: false },
          right: { visible: true, initial: 'expanded' },
        },
      }),
    );
    expect(result.panels.left).toEqual({ initial: 'expanded', label: 'Nav' });
    expect(result.panels.bottom).toBe(false);
    expect(result.panels.top).toBe(false);
    // The host removed `right`; a layout cannot bring it back.
    expect(result.panels.right).toBe(false);
  });

  it('survives a malformed layout object', () => {
    const bad = {
      version: 1,
      sectionOrder: 'nope',
      itemOrder: [1],
      hidden: [3, '/inbox'],
      moved: 'x',
      panels: { left: 4 },
    } as unknown as ShellLayout;
    const nulls = {
      version: 1,
      itemOrder: null,
      moved: null,
      panels: null,
      hidden: null,
    } as unknown as ShellLayout;
    expect(isShellLayoutEmpty(nulls)).toBe(true);
    expect(applyShellLayout(nav, groups, {}, nulls).nav).toBe(nav);
    expect(() => applyShellLayout(nav, groups, {}, bad)).not.toThrow();
    expect(hrefs(applyShellLayout(nav, groups, {}, bad).nav)).toEqual(['/']);
  });
});

describe('normalizeShellLayout', () => {
  it('yields an empty layout for unreadable or unknown-version input', () => {
    for (const input of [null, 7, 'x', [], { version: 2, hidden: ['a'] }, {}]) {
      expect(normalizeShellLayout(input)).toEqual({ version: 1 });
    }
  });

  it('keeps valid fields and drops malformed ones', () => {
    expect(
      normalizeShellLayout({
        version: 1,
        sectionOrder: ['a', 'a', 4, ''],
        itemOrder: { a: ['x', 'x'], b: [], c: 'no' },
        hidden: ['h'],
        moved: { i: 's', j: 3 },
        panels: {
          left: { visible: false, initial: 'expanded', extra: 1 },
          right: { initial: 'hidden' },
          nope: { visible: false },
        },
        extra: true,
      }),
    ).toEqual({
      version: 1,
      sectionOrder: ['a'],
      itemOrder: { a: ['x'] },
      hidden: ['h'],
      moved: { i: 's' },
      panels: { left: { visible: false, initial: 'expanded' } },
    });
  });

  it('round-trips through JSON', () => {
    const value = layout({ hidden: ['a'], moved: { b: 'c' } });
    expect(normalizeShellLayout(JSON.parse(JSON.stringify(value)))).toEqual(
      value,
    );
  });
});

describe('layout mutations', () => {
  const apply = (l: ShellLayout) => applyShellLayout(nav, groups, {}, l);

  it('moves a section and drops the order when it matches the default', () => {
    const moved = moveShellSection(nav, groups, undefined, 'ops', 0);
    expect(moved.sectionOrder).toEqual(['ops', 'Content', 'People']);
    expect(headings(apply(moved).groups)).toEqual([
      'Operations',
      'Content',
      'People',
    ]);
    const back = moveShellSection(nav, groups, moved, 'ops', 99);
    expect(back).toEqual({ version: 1 });
  });

  it('ignores moving the root or an unknown section', () => {
    expect(
      moveShellSection(nav, groups, undefined, SHELL_NAV_ROOT_SECTION_ID, 1),
    ).toEqual({ version: 1 });
    expect(moveShellSection(nav, groups, undefined, 'zzz', 1)).toEqual({
      version: 1,
    });
  });

  it('reorders within a section', () => {
    const next = moveShellItem(nav, groups, undefined, '/media', 'Content', 0);
    expect(next).toEqual({
      version: 1,
      itemOrder: { Content: ['/media', '/posts', '/pages'] },
    });
  });

  it('moves between sections and records both orders only when needed', () => {
    const next = moveShellItem(nav, groups, undefined, '/roles', 'Content', 1);
    expect(next.moved).toEqual({ '/roles': 'Content' });
    expect(next.itemOrder).toEqual({
      Content: ['/posts', '/roles', '/pages', '/media'],
    });
    expect(hrefs(apply(next).groups[1].items)).toEqual(['/users']);
    // Moving it home restores the default and prunes everything.
    const home = moveShellItem(nav, groups, next, '/roles', 'People');
    expect(home).toEqual({ version: 1 });
  });

  it('moves into the root and appends by default', () => {
    const next = moveShellItem(
      nav,
      groups,
      undefined,
      '/jobs',
      SHELL_NAV_ROOT_SECTION_ID,
    );
    expect(hrefs(apply(next).nav)).toEqual(['/', '/inbox', '/jobs']);
    expect(next.moved).toEqual({ '/jobs': '@root' });
  });

  it('ignores unknown items and sections', () => {
    expect(moveShellItem(nav, groups, undefined, '/x', 'Content')).toEqual({
      version: 1,
    });
    expect(moveShellItem(nav, groups, undefined, '/posts', 'Nowhere')).toEqual({
      version: 1,
    });
  });

  it('hides and shows, ignoring unknown ids and duplicates', () => {
    let next = hideShellEntry(nav, groups, undefined, '/posts');
    next = hideShellEntry(nav, groups, next, '/posts');
    next = hideShellEntry(nav, groups, next, 'People');
    next = hideShellEntry(nav, groups, next, 'nope');
    next = hideShellEntry(nav, groups, next, SHELL_NAV_ROOT_SECTION_ID);
    expect(next.hidden).toEqual(['/posts', 'People']);
    next = showShellEntry(next, '/posts');
    next = showShellEntry(next, 'People');
    expect(next).toEqual({ version: 1 });
  });

  it('sets panels sparsely against host defaults', () => {
    let next = setShellLayoutPanel(undefined, 'left', { visible: false });
    expect(next.panels).toEqual({ left: { visible: false } });
    next = setShellLayoutPanel(next, 'left', { initial: 'expanded' });
    expect(next.panels).toEqual({
      left: { visible: false, initial: 'expanded' },
    });
    next = setShellLayoutPanel(next, 'left', { visible: true });
    expect(next.panels).toEqual({ left: { initial: 'expanded' } });
    next = setShellLayoutPanel(next, 'left', { initial: 'collapsed' }, {});
    expect(next).toEqual({ version: 1 });
  });

  it('does not mutate the layout it is given', () => {
    const base = layout({ hidden: ['/posts'] });
    const snapshot = JSON.stringify(base);
    hideShellEntry(nav, groups, base, '/pages');
    showShellEntry(base, '/posts');
    moveShellItem(nav, groups, base, '/media', 'People', 0);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('reports emptiness', () => {
    expect(isShellLayoutEmpty(createShellLayout())).toBe(true);
    expect(isShellLayoutEmpty(layout({ hidden: ['a'] }))).toBe(false);
  });
});

describe('settings core', () => {
  it('stores a layout in the sparse settings delta and drops an empty one', () => {
    const stored = layout({ hidden: ['/posts'] });
    expect(pruneShellSettingsDelta({ layout: stored }).layout).toEqual(stored);
    expect(pruneShellSettingsDelta({ layout: layout({}) })).toEqual({});
    expect(
      pruneShellSettingsDelta({ layout: { version: 9 } as never }),
    ).toEqual({});
  });
});

describe('app-owned sections', () => {
  const custom = (items: Partial<ShellLayout> = {}): ShellLayout =>
    layout({
      customSections: [{ id: 'custom:fav', label: 'Favorites' }],
      ...items,
    });

  it('renames a section and keeps its id stable', () => {
    const next = renameShellSection(
      nav,
      groups,
      undefined,
      'Content',
      ' Stuff ',
    );
    expect(next).toEqual(layout({ sections: { Content: { label: 'Stuff' } } }));
    const applied = applyShellLayout(nav, groups, undefined, next);
    expect(headings(applied.groups)).toEqual(['Stuff', 'People', 'Operations']);
    expect(applied.groups[0].id).toBe('Content');
    // Rename survives reordering by the original id.
    const moved = moveShellSection(nav, groups, next, 'Content', 2);
    expect(
      headings(applyShellLayout(nav, groups, undefined, moved).groups),
    ).toEqual(['People', 'Operations', 'Stuff']);
  });

  it('drops the override for a blank label or the host heading', () => {
    const renamed = renameShellSection(nav, groups, undefined, 'Content', 'X');
    expect(renameShellSection(nav, groups, renamed, 'Content', '  ')).toEqual(
      layout({}),
    );
    expect(
      renameShellSection(nav, groups, renamed, 'Content', 'Content'),
    ).toEqual(layout({}));
    expect(renameShellSection(nav, groups, undefined, 'nope', 'X')).toEqual(
      layout({}),
    );
    expect(
      renameShellSection(
        nav,
        groups,
        undefined,
        SHELL_NAV_ROOT_SECTION_ID,
        'X',
      ),
    ).toEqual(layout({}));
  });

  it('hides and restores a title, rendering the group flat', () => {
    const off = setShellSectionTitleVisible(
      nav,
      groups,
      undefined,
      'People',
      false,
    );
    expect(off).toEqual(layout({ sections: { People: { showTitle: false } } }));
    const applied = applyShellLayout(nav, groups, undefined, off);
    expect(applied.groups[1].showTitle).toBe(false);
    expect(applied.groups[1].items).toHaveLength(2);
    expect(applied.groups[0].showTitle).toBeUndefined();
    expect(
      setShellSectionTitleVisible(nav, groups, off, 'People', true),
    ).toEqual(layout({}));
  });

  it('lets a user show a title the host suggested hidden', () => {
    const suggested: ShellNavGroup[] = [{ ...groups[0], showTitle: false }];
    expect(
      applyShellLayout([], suggested, undefined, layout({})).groups[0]
        .showTitle,
    ).toBe(false);
    const on = setShellSectionTitleVisible(
      [],
      suggested,
      undefined,
      'Content',
      true,
    );
    expect(on.sections).toEqual({ Content: { showTitle: true } });
    expect(
      applyShellLayout([], suggested, undefined, on).groups[0].showTitle,
    ).toBeUndefined();
    expect(
      setShellSectionTitleVisible([], suggested, on, 'Content', false),
    ).toEqual(layout({}));
  });

  it('creates a custom section with a unique id', () => {
    const one = createShellSection(nav, groups, undefined, 'Favorites');
    expect(one.customSections).toEqual([
      { id: 'custom:favorites', label: 'Favorites' },
    ]);
    const two = createShellSection(nav, groups, one, 'Favorites');
    expect(two.customSections?.map((c) => c.id)).toEqual([
      'custom:favorites',
      'custom:favorites-2',
    ]);
    expect(createShellSection(nav, groups, one, '   ')).toEqual(one);
  });

  it('shows an empty custom section in the model but not in the nav', () => {
    const l = custom();
    const model = resolveShellNavModel(nav, groups, l);
    const section = model.at(-1);
    expect(section).toMatchObject({
      id: 'custom:fav',
      heading: 'Favorites',
      custom: true,
      defaultHeading: null,
      titleVisible: true,
    });
    expect(section?.items).toEqual([]);
    expect(
      headings(applyShellLayout(nav, groups, undefined, l).groups),
    ).toEqual(['Content', 'People', 'Operations']);
  });

  it('moves items into a custom section and orders it', () => {
    let l = custom();
    l = moveShellItem(nav, groups, l, '/posts', 'custom:fav');
    expect(l.moved).toEqual({ '/posts': 'custom:fav' });
    l = moveShellSection(nav, groups, l, 'custom:fav', 0);
    expect(l.sectionOrder).toEqual(['custom:fav', 'Content', 'People', 'ops']);
    const applied = applyShellLayout(nav, groups, undefined, l);
    expect(headings(applied.groups)).toEqual([
      'Favorites',
      'Content',
      'People',
      'Operations',
    ]);
    expect(hrefs(applied.groups[0].items)).toEqual(['/posts']);
    expect(applied.groups[0].id).toBe('custom:fav');
    // Moving back to the default section and the default order stays sparse.
    expect(
      moveShellSection(nav, groups, custom(), 'custom:fav', 99).sectionOrder,
    ).toBeUndefined();
  });

  it('renames a custom section and hides its title', () => {
    let l = renameShellSection(nav, groups, custom(), 'custom:fav', 'Pinned');
    expect(l.customSections).toEqual([{ id: 'custom:fav', label: 'Pinned' }]);
    expect(renameShellSection(nav, groups, l, 'custom:fav', ' ')).toEqual(l);
    l = setShellSectionTitleVisible(nav, groups, l, 'custom:fav', false);
    l = moveShellItem(nav, groups, l, '/jobs', 'custom:fav');
    const group = applyShellLayout(nav, groups, undefined, l).groups.find(
      (g) => g.id === 'custom:fav',
    );
    expect(group).toMatchObject({ heading: 'Pinned', showTitle: false });
  });

  it('hides a custom section by id', () => {
    const l = hideShellEntry(
      nav,
      groups,
      custom({ moved: { '/posts': 'custom:fav' } }),
      'custom:fav',
    );
    expect(l.hidden).toEqual(['custom:fav']);
    expect(
      headings(applyShellLayout(nav, groups, undefined, l).groups),
    ).not.toContain('Favorites');
  });

  it('deletes a custom section and returns its items to their defaults', () => {
    let l = custom();
    l = moveShellItem(nav, groups, l, '/posts', 'custom:fav');
    l = moveShellSection(nav, groups, l, 'custom:fav', 0);
    l = hideShellEntry(nav, groups, l, 'custom:fav');
    l = setShellSectionTitleVisible(nav, groups, l, 'custom:fav', false);
    const next = deleteShellSection(l, 'custom:fav');
    expect(next.customSections).toBeUndefined();
    expect(next.moved).toBeUndefined();
    expect(next.hidden).toBeUndefined();
    expect(next.sections).toBeUndefined();
    expect(next.sectionOrder).toEqual(['Content', 'People', 'ops']);
    const applied = applyShellLayout(nav, groups, undefined, next);
    expect(applied.groups[0].items.map((i) => i.href)).toEqual([
      '/posts',
      '/pages',
      '/media',
    ]);
  });

  it('refuses to delete host sections or unknown ids', () => {
    const l = layout({ hidden: ['People'] });
    expect(deleteShellSection(l, 'People')).toEqual(l);
    expect(deleteShellSection(l, 'custom:nope')).toEqual(l);
  });

  it('keeps new host sections and items in their suggested place', () => {
    const stored = custom({
      sections: { Content: { label: 'Stuff' } },
      moved: { '/posts': 'custom:fav' },
    });
    const evolved: ShellNavGroup[] = [
      {
        ...groups[0],
        items: [...groups[0].items, { href: '/new', label: 'New' }],
      },
      ...groups.slice(1),
      { heading: 'Billing', items: [{ href: '/bill', label: 'Bill' }] },
    ];
    const applied = applyShellLayout(nav, evolved, undefined, stored);
    expect(headings(applied.groups)).toEqual([
      'Stuff',
      'People',
      'Operations',
      'Billing',
      'Favorites',
    ]);
    expect(hrefs(applied.groups[0].items)).toEqual([
      '/pages',
      '/media',
      '/new',
    ]);
    expect(hrefs(applied.groups[4].items)).toEqual(['/posts']);
  });

  it('ignores unknown ids and normalizes malformed input', () => {
    const l = normalizeShellLayout({
      version: 1,
      sections: {
        ghost: { label: 'Boo' },
        People: { label: 5, showTitle: 'no' },
        bad: 3,
      },
      customSections: [
        { id: 'custom:ok', label: ' Ok ' },
        { id: 'plain', label: 'No prefix' },
        { id: 'custom:blank', label: ' ' },
        { id: 'custom:ok', label: 'Dup' },
        'x',
      ],
    });
    expect(l).toEqual({
      version: 1,
      sections: { ghost: { label: 'Boo' } },
      customSections: [{ id: 'custom:ok', label: 'Ok' }],
    });
    expect(
      headings(applyShellLayout(nav, groups, undefined, l).groups),
    ).toEqual(['Content', 'People', 'Operations']);
  });

  it('renames an item by id, keeping the original label available', () => {
    const next = renameShellItem(
      nav,
      groups,
      undefined,
      '/posts',
      '  Articles ',
    );
    expect(next).toEqual(
      layout({ items: { '/posts': { label: 'Articles' } } }),
    );
    const applied = applyShellLayout(nav, groups, undefined, next);
    const posts = applied.groups[0].items[0];
    expect(posts.label).toBe('Articles');
    expect(posts.defaultLabel).toBe('Posts');
    expect(posts.href).toBe('/posts');
    // Untouched items are the host's own objects.
    expect(applied.groups[0].items[1]).toBe(groups[0].items[1]);
    // Survives moving into another section, and the root list.
    const moved = moveShellItem(nav, groups, next, '/posts', 'ops');
    const after = applyShellLayout(nav, groups, undefined, moved);
    expect(after.groups[2].items.map((i) => i.label)).toContain('Articles');
    const root = renameShellItem(nav, groups, undefined, '/inbox', 'Mail');
    expect(
      applyShellLayout(nav, groups, undefined, root).nav.map((i) => i.label),
    ).toEqual(['Home', 'Mail']);
  });

  it('drops an item override for null, blank, the host label, or unknown ids', () => {
    const renamed = renameShellItem(nav, groups, undefined, '/posts', 'X');
    expect(renameShellItem(nav, groups, renamed, '/posts', null)).toEqual(
      layout({}),
    );
    expect(renameShellItem(nav, groups, renamed, '/posts', '  ')).toEqual(
      layout({}),
    );
    expect(renameShellItem(nav, groups, renamed, '/posts', 'Posts')).toEqual(
      layout({}),
    );
    expect(renameShellItem(nav, groups, undefined, '/nope', 'X')).toEqual(
      layout({}),
    );
    expect(isShellLayoutEmpty(renamed)).toBe(false);
  });

  it('normalizes item overrides like section labels', () => {
    expect(
      normalizeShellLayout({
        version: 1,
        items: {
          '/a': { label: ' A ' },
          '/b': { label: '   ' },
          '/c': { label: 5 },
          '/d': 'x',
          '': { label: 'E' },
        },
      }),
    ).toEqual(layout({ items: { '/a': { label: 'A' } } }));
    expect(normalizeShellLayout({ version: 1, items: [] })).toEqual(layout({}));
  });

  it('keeps a stored version 1 layout without the new fields working', () => {
    const old = {
      version: 1,
      sectionOrder: ['People', 'Content'],
      hidden: ['/roles'],
      moved: { '/jobs': 'People' },
    };
    const l = normalizeShellLayout(old);
    expect(l).toEqual(old);
    expect(
      isShellLayoutEmpty(layout({ sections: { A: { showTitle: false } } })),
    ).toBe(false);
    expect(isShellLayoutEmpty(custom())).toBe(false);
    const applied = applyShellLayout(nav, groups, undefined, l);
    expect(headings(applied.groups)).toEqual(['People', 'Content']);
    expect(applied.groups[0].showTitle).toBeUndefined();
  });
});
