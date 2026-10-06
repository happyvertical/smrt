/**
 * User-customizable shell layout: a small, versioned, JSON-serializable delta
 * applied over the navigation and panel defaults the host generates.
 *
 * This module is pure (no Svelte, no DOM) so a host can validate, store,
 * export, or apply a layout anywhere, including on the server. It is also
 * published as `@happyvertical/smrt-svelte/workspace/layout`.
 *
 * Ids: sections are identified by `ShellNavGroup.id ?? heading`, items by
 * `ShellNavItem.id ?? href`. Sections and items share one id namespace (the
 * `hidden` list holds both), so keep them unique; later duplicates get a
 * `#2`, `#3`, ... suffix. The flat `nav` items form an implicit first
 * section, {@link SHELL_NAV_ROOT_SECTION_ID}, which always renders first and
 * cannot be reordered or hidden as a whole.
 */
import type {
  PanelEdge,
  ShellNavGroup,
  ShellNavItem,
  ShellPanelDefaults,
} from './types.js';

/** The only layout format version this package reads and writes. */
export const SHELL_LAYOUT_VERSION = 1 as const;

/** Section id of the flat `nav` items rendered above all groups. */
export const SHELL_NAV_ROOT_SECTION_ID = '@root';

const EDGES: readonly PanelEdge[] = ['top', 'left', 'right', 'bottom'];

/** A user's choice for one edge panel. */
export interface ShellLayoutPanel {
  /** `false` hides the edge; absent or `true` keeps it as configured. */
  visible?: boolean;
  /** The state the edge starts in. */
  initial?: 'collapsed' | 'expanded';
}

/**
 * A user's customization of the shell, stored as a sparse delta over what the
 * host generates. Every field is optional; unknown ids are ignored.
 */
export interface ShellLayout {
  version: 1;
  /** Section ids in display order. Sections not listed keep their slot. */
  sectionOrder?: string[];
  /** Per section id, item ids in display order. */
  itemOrder?: Record<string, string[]>;
  /** Ids of hidden sections and items. */
  hidden?: string[];
  /** Item id to the id of the section it was moved into. */
  moved?: Record<string, string>;
  /** Per edge panel overrides. */
  panels?: Partial<Record<PanelEdge, ShellLayoutPanel>>;
}

/** An item as the layout sees it. */
export interface ShellNavModelItem {
  id: string;
  item: ShellNavItem;
  /** The section the host put the item in. */
  nativeSectionId: string;
  /** The section it is displayed in (differs when moved). */
  sectionId: string;
  /** Hidden by its own id. */
  hidden: boolean;
}

/** A section as the layout sees it. */
export interface ShellNavModelSection {
  id: string;
  /** `null` for the implicit root section of flat `nav` items. */
  group: ShellNavGroup | null;
  heading: string | null;
  hidden: boolean;
  /** Items in display order, including hidden ones. */
  items: ShellNavModelItem[];
}

/** Result of {@link applyShellLayout}. */
export interface AppliedShellLayout {
  nav: ShellNavItem[];
  groups: ShellNavGroup[];
  panels: ShellPanelDefaults;
}

export function createShellLayout(): ShellLayout {
  return { version: SHELL_LAYOUT_VERSION };
}

/** A layout with no customization (nothing to apply). */
export function isShellLayoutEmpty(layout: ShellLayout | null | undefined) {
  if (!layout) return true;
  return (
    !layout.sectionOrder?.length &&
    !hasKeys(layout.itemOrder) &&
    !layout.hidden?.length &&
    !hasKeys(layout.moved) &&
    !hasKeys(layout.panels)
  );
}

function hasKeys(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry !== '') seen.add(entry);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/**
 * Read an untrusted value (stored JSON, an imported blueprint) as a layout.
 * Never throws: anything unreadable, including a version this package does not
 * know, yields an empty layout, and unknown or malformed fields are dropped.
 */
export function normalizeShellLayout(input: unknown): ShellLayout {
  const layout = createShellLayout();
  if (!isRecord(input) || input.version !== SHELL_LAYOUT_VERSION) return layout;

  const sectionOrder = stringList(input.sectionOrder);
  if (sectionOrder) layout.sectionOrder = sectionOrder;

  if (isRecord(input.itemOrder)) {
    const itemOrder: Record<string, string[]> = {};
    for (const [section, ids] of Object.entries(input.itemOrder)) {
      const list = stringList(ids);
      if (list) itemOrder[section] = list;
    }
    if (hasKeys(itemOrder)) layout.itemOrder = itemOrder;
  }

  const hidden = stringList(input.hidden);
  if (hidden) layout.hidden = hidden;

  if (isRecord(input.moved)) {
    const moved: Record<string, string> = {};
    for (const [id, section] of Object.entries(input.moved)) {
      if (typeof section === 'string' && section !== '') moved[id] = section;
    }
    if (hasKeys(moved)) layout.moved = moved;
  }

  if (isRecord(input.panels)) {
    const panels: Partial<Record<PanelEdge, ShellLayoutPanel>> = {};
    for (const edge of EDGES) {
      const raw = input.panels[edge];
      if (!isRecord(raw)) continue;
      const panel: ShellLayoutPanel = {};
      if (typeof raw.visible === 'boolean') panel.visible = raw.visible;
      if (raw.initial === 'collapsed' || raw.initial === 'expanded') {
        panel.initial = raw.initial;
      }
      if (hasKeys(panel)) panels[edge] = panel;
    }
    if (hasKeys(panels)) layout.panels = panels;
  }
  return layout;
}

export function shellNavGroupId(group: ShellNavGroup): string {
  return group.id ?? group.heading;
}

export function shellNavItemId(item: ShellNavItem): string {
  return item.id ?? item.href;
}

/**
 * Keep every listed id that is present, in the listed order, in the slots the
 * listed ids already occupy. Ids the list does not mention (for example new
 * ones the host added later) stay exactly where the defaults put them.
 */
function mergeOrder(
  defaults: readonly string[],
  preferred: readonly string[] | undefined,
): string[] {
  if (!preferred || preferred.length === 0) return [...defaults];
  const present = new Set(defaults);
  const listed: string[] = [];
  const listedSet = new Set<string>();
  for (const id of preferred) {
    if (present.has(id) && !listedSet.has(id)) {
      listedSet.add(id);
      listed.push(id);
    }
  }
  if (listed.length === 0) return [...defaults];
  let next = 0;
  return defaults.map((id) => (listedSet.has(id) ? listed[next++] : id));
}

/**
 * The navigation as the layout sees it: every section and item (hidden ones
 * flagged, not removed) in display order. An editor renders this; the shell
 * renders {@link applyShellLayout}'s filtered result.
 */
export function resolveShellNavModel(
  nav: readonly ShellNavItem[] = [],
  groups: readonly ShellNavGroup[] = [],
  layout?: ShellLayout | null,
): ShellNavModelSection[] {
  const used = new Set<string>([SHELL_NAV_ROOT_SECTION_ID]);
  const unique = (id: string): string => {
    let candidate = id;
    for (let n = 2; used.has(candidate); n += 1) candidate = `${id}#${n}`;
    used.add(candidate);
    return candidate;
  };

  interface Native {
    id: string;
    group: ShellNavGroup | null;
    items: Array<{ id: string; item: ShellNavItem }>;
  }
  const natives: Native[] = [
    {
      id: SHELL_NAV_ROOT_SECTION_ID,
      group: null,
      items: nav.map((item) => ({ id: unique(shellNavItemId(item)), item })),
    },
  ];
  for (const group of groups) {
    const id = unique(shellNavGroupId(group));
    natives.push({
      id,
      group,
      items: group.items.map((item) => ({
        id: unique(shellNavItemId(item)),
        item,
      })),
    });
  }

  const hidden = new Set(stringList(layout?.hidden) ?? []);
  const moved = isRecord(layout?.moved)
    ? (layout?.moved as Record<string, unknown>)
    : {};
  const sectionIds = new Set(natives.map((section) => section.id));
  const itemIds = new Set(
    natives.flatMap((section) => section.items.map((entry) => entry.id)),
  );

  /** Where an item is displayed: its moved-to section when that exists. */
  const displayedIn = (id: string, native: string): string => {
    const target = itemIds.has(id) ? moved[id] : undefined;
    return typeof target === 'string' && sectionIds.has(target)
      ? target
      : native;
  };

  const groupSections = natives.slice(1).map((section) => section.id);
  const orderedGroupIds = mergeOrder(
    groupSections,
    stringList(layout?.sectionOrder),
  );
  const byId = new Map(natives.map((section) => [section.id, section]));
  const orderedSections = [
    natives[0],
    ...orderedGroupIds.map((id) => byId.get(id) as Native),
  ];

  const itemOrder = isRecord(layout?.itemOrder)
    ? (layout?.itemOrder as Record<string, unknown>)
    : {};

  return orderedSections.map((section) => {
    const defaults: ShellNavModelItem[] = [];
    for (const native of natives) {
      for (const entry of native.items) {
        if (displayedIn(entry.id, native.id) !== section.id) continue;
        defaults.push({
          id: entry.id,
          item: entry.item,
          nativeSectionId: native.id,
          sectionId: section.id,
          hidden: hidden.has(entry.id),
        });
      }
    }
    // Items the host placed here keep their order; moved-in items follow.
    defaults.sort(
      (a, b) =>
        Number(a.nativeSectionId !== section.id) -
        Number(b.nativeSectionId !== section.id),
    );
    const byItem = new Map(defaults.map((entry) => [entry.id, entry]));
    const order = mergeOrder(
      defaults.map((entry) => entry.id),
      stringList(itemOrder[section.id]),
    );
    return {
      id: section.id,
      group: section.group,
      heading: section.group ? section.group.heading : null,
      hidden: section.group ? hidden.has(section.id) : false,
      items: order.map((id) => byItem.get(id) as ShellNavModelItem),
    };
  });
}

/** The state an edge starts in once a layout override is applied. */
export function applyShellLayoutPanel(
  base: ShellPanelDefaults[PanelEdge],
  panel: ShellLayoutPanel | undefined,
): ShellPanelDefaults[PanelEdge] {
  if (!panel) return base;
  // `false` and `initial: 'hidden'` mean the host has no such panel; a
  // layout can hide a panel but never conjures one the host removed.
  if (base === false || base?.initial === 'hidden') return base;
  if (panel.visible === false) return false;
  if (panel.initial === 'collapsed' || panel.initial === 'expanded') {
    return { ...base, initial: panel.initial };
  }
  return base;
}

/**
 * Apply a layout over host-generated navigation and panel defaults.
 *
 * Pure and total: ids the host no longer has are ignored, items and sections
 * the layout does not mention keep their default positions, and an empty or
 * missing layout returns the inputs unchanged. Sections the layout empties
 * (every item hidden or moved away) are dropped from `groups`.
 */
export function applyShellLayout(
  nav: ShellNavItem[],
  groups: ShellNavGroup[],
  panels: ShellPanelDefaults | undefined,
  layout: ShellLayout | null | undefined,
): AppliedShellLayout {
  const basePanels = panels ?? {};
  if (isShellLayoutEmpty(layout)) {
    return { nav, groups, panels: basePanels };
  }

  const model = resolveShellNavModel(nav, groups, layout);
  const visible = (section: ShellNavModelSection): ShellNavItem[] =>
    section.hidden
      ? []
      : section.items.filter((entry) => !entry.hidden).map((e) => e.item);

  const [root, ...sections] = model;
  const nextGroups: ShellNavGroup[] = [];
  for (const section of sections) {
    const items = visible(section);
    const group = section.group as ShellNavGroup;
    if (items.length === 0 && group.items.length > 0) continue;
    nextGroups.push({ ...group, items });
  }

  const nextPanels: ShellPanelDefaults = { ...basePanels };
  const overrides = isRecord(layout?.panels) ? layout?.panels : undefined;
  for (const edge of EDGES) {
    const override = overrides?.[edge];
    if (!isRecord(override)) continue;
    const next = applyShellLayoutPanel(basePanels[edge], override);
    if (next !== undefined) nextPanels[edge] = next;
  }

  return { nav: visible(root), groups: nextGroups, panels: nextPanels };
}

// Mutations. Each returns a new sparse layout and never mutates its input.

function compact(layout: ShellLayout): ShellLayout {
  const next: ShellLayout = { version: SHELL_LAYOUT_VERSION };
  if (layout.sectionOrder?.length) next.sectionOrder = layout.sectionOrder;
  if (hasKeys(layout.itemOrder)) next.itemOrder = layout.itemOrder;
  if (layout.hidden?.length) next.hidden = layout.hidden;
  if (hasKeys(layout.moved)) next.moved = layout.moved;
  if (hasKeys(layout.panels)) next.panels = layout.panels;
  return next;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function clampIndex(index: number, max: number): number {
  if (!Number.isFinite(index)) return max;
  return Math.max(0, Math.min(Math.trunc(index), max));
}

/**
 * Move a group section to `toIndex` among the groups (the root section is not
 * counted). Returns the layout unchanged when `sectionId` is not a group.
 */
export function moveShellSection(
  nav: readonly ShellNavItem[],
  groups: readonly ShellNavGroup[],
  layout: ShellLayout | null | undefined,
  sectionId: string,
  toIndex: number,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  const ids = resolveShellNavModel(nav, groups, current)
    .slice(1)
    .map((section) => section.id);
  if (!ids.includes(sectionId)) return current;
  const next = ids.filter((id) => id !== sectionId);
  next.splice(clampIndex(toIndex, next.length), 0, sectionId);
  const defaults = resolveShellNavModel(nav, groups)
    .slice(1)
    .map((section) => section.id);
  const sectionOrder = sameList(next, defaults) ? undefined : next;
  return compact({ ...current, sectionOrder });
}

/**
 * Move an item into `toSectionId` (a group or the root section) at `toIndex`
 * among that section's items, hidden ones included. `toIndex` defaults to the
 * end. Returns the layout unchanged when either id is unknown.
 */
export function moveShellItem(
  nav: readonly ShellNavItem[],
  groups: readonly ShellNavGroup[],
  layout: ShellLayout | null | undefined,
  itemId: string,
  toSectionId: string,
  toIndex?: number,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  const model = resolveShellNavModel(nav, groups, current);
  const source = model.find((section) =>
    section.items.some((entry) => entry.id === itemId),
  );
  const target = model.find((section) => section.id === toSectionId);
  if (!source || !target) return current;
  const entry = source.items.find((candidate) => candidate.id === itemId);
  if (!entry) return current;

  const lists = new Map(
    model.map((section) => [
      section.id,
      section.items.map((candidate) => candidate.id),
    ]),
  );
  lists.set(
    source.id,
    (lists.get(source.id) ?? []).filter((id) => id !== itemId),
  );
  const targetList = [...(lists.get(target.id) ?? [])];
  targetList.splice(
    clampIndex(toIndex ?? targetList.length, targetList.length),
    0,
    itemId,
  );
  lists.set(target.id, targetList);

  const moved = { ...(current.moved ?? {}) };
  if (target.id === entry.nativeSectionId) delete moved[itemId];
  else moved[itemId] = target.id;

  // With `moved` settled, a section's default order is what an empty
  // itemOrder would give; write an order only where it differs.
  const settled: ShellLayout = { ...current, moved };
  const defaultModel = resolveShellNavModel(nav, groups, {
    version: SHELL_LAYOUT_VERSION,
    moved,
    sectionOrder: current.sectionOrder,
  });
  const itemOrder = { ...(current.itemOrder ?? {}) };
  for (const id of new Set([source.id, target.id])) {
    const defaults = defaultModel
      .find((section) => section.id === id)
      ?.items.map((candidate) => candidate.id);
    const list = lists.get(id) ?? [];
    if (defaults && sameList(list, defaults)) delete itemOrder[id];
    else itemOrder[id] = list;
  }
  return compact({ ...settled, itemOrder });
}

/** Hide a section or item. Unknown ids and the root section are ignored. */
export function hideShellEntry(
  nav: readonly ShellNavItem[],
  groups: readonly ShellNavGroup[],
  layout: ShellLayout | null | undefined,
  id: string,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  if (!isKnownEntry(nav, groups, id) || current.hidden?.includes(id)) {
    return current;
  }
  return compact({ ...current, hidden: [...(current.hidden ?? []), id] });
}

/** Show a hidden section or item again. */
export function showShellEntry(
  layout: ShellLayout | null | undefined,
  id: string,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  if (!current.hidden?.includes(id)) return current;
  return compact({
    ...current,
    hidden: current.hidden.filter((entry) => entry !== id),
  });
}

function isKnownEntry(
  nav: readonly ShellNavItem[],
  groups: readonly ShellNavGroup[],
  id: string,
): boolean {
  return resolveShellNavModel(nav, groups).some(
    (section) =>
      (section.group !== null && section.id === id) ||
      section.items.some((entry) => entry.id === id),
  );
}

/**
 * Set an edge panel's `visible` and/or `initial`. Values equal to the host's
 * defaults (`defaults`, when given) are dropped to keep the layout sparse.
 */
export function setShellLayoutPanel(
  layout: ShellLayout | null | undefined,
  edge: PanelEdge,
  patch: ShellLayoutPanel,
  defaults?: ShellPanelDefaults,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  if (!EDGES.includes(edge)) return current;
  const panel: ShellLayoutPanel = { ...(current.panels?.[edge] ?? {}) };
  if ('visible' in patch) {
    if (patch.visible === false) panel.visible = false;
    else delete panel.visible;
  }
  if ('initial' in patch) {
    if (patch.initial === 'collapsed' || patch.initial === 'expanded') {
      panel.initial = patch.initial;
    } else delete panel.initial;
  }
  const base = defaults?.[edge];
  if (
    panel.initial !== undefined &&
    base !== false &&
    panel.initial === (base?.initial ?? 'collapsed')
  ) {
    delete panel.initial;
  }
  const panels = { ...(current.panels ?? {}) };
  if (hasKeys(panel)) panels[edge] = panel;
  else delete panels[edge];
  return compact({ ...current, panels });
}
