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
import {
  isShellSlot,
  resolveSlot,
  SHELL_SLOTS,
  type ShellPlacementItem,
  type ShellRegion,
  type ShellSlot,
} from './slots.js';
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

/** Prefix of the ids of user-created sections. */
export const SHELL_CUSTOM_SECTION_PREFIX = 'custom:';

/** A user's override of one section's presentation. */
export interface ShellLayoutSection {
  /** Replaces the section's heading. */
  label?: string;
  /** `false` renders the section's items flat, without a visible heading. */
  showTitle?: boolean;
  /** Replaces the section's icon (a shell icon name or a host icon name). */
  icon?: string;
}

/** A user's override of one navigation item's presentation. */
export interface ShellLayoutItem {
  /** Replaces the item's label wherever the shell shows it. */
  label?: string;
  /**
   * Replaces the item's `description` (the line on a section card). Set by
   * hosts or presets; the layout editor does not edit it.
   */
  description?: string;
}

/** A section the user created (its id starts with `custom:`). */
export interface ShellLayoutCustomSection {
  id: string;
  label: string;
}

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
  /**
   * Per section id presentation overrides: a new heading and/or whether the
   * title shows. Sections are suggested by the host; these are the user's.
   */
  sections?: Record<string, ShellLayoutSection>;
  /**
   * Per navigation item id presentation overrides: a new label (e.g. "Sales
   * orders" becomes "Work orders"). The host's original label stays on the
   * applied item as `defaultLabel`. Additive; layouts without it load unchanged.
   */
  items?: Record<string, ShellLayoutItem>;
  /**
   * Sections the user created. They join `sectionOrder` like host sections;
   * items move in through `moved`. Empty ones show in an editor, not the nav.
   */
  customSections?: ShellLayoutCustomSection[];
  /** Per edge panel overrides. */
  panels?: Partial<Record<PanelEdge, ShellLayoutPanel>>;
  /**
   * Shell item id (`dock:<tool>`, `slot:<slot>`, or a host `slotItems` id) to
   * the slot the user moved it to. Applied before the hidden-region fallback;
   * unknown ids and slots are ignored. Items placed into a slot follow the
   * slot's own items, in the order of this record.
   */
  placements?: Record<string, ShellSlot>;
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
  /** The displayed label (the user's rename, else the host's). */
  label: string;
  /** The host's label (`item.label`). */
  defaultLabel: string;
}

/** A section as the layout sees it. */
export interface ShellNavModelSection {
  id: string;
  /** `null` for the implicit root section of flat `nav` items. */
  group: ShellNavGroup | null;
  /** The displayed heading (the user's rename, else the host's). */
  heading: string | null;
  /** The host's suggested heading; `null` for the root and custom sections. */
  defaultHeading: string | null;
  /** Created by the user rather than suggested by the host. */
  custom: boolean;
  /** Whether the title is displayed (the root has none). */
  titleVisible: boolean;
  /** The displayed icon (the user's choice, else the host's), if any. */
  icon: string | null;
  /** The host's suggested icon; `null` when it suggests none. */
  defaultIcon: string | null;
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
    !hasKeys(layout.sections) &&
    !hasKeys(layout.items) &&
    !layout.customSections?.length &&
    !hasKeys(layout.panels) &&
    !hasKeys(layout.placements)
  );
}

function hasKeys(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && Object.keys(value).length > 0
  );
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

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  return label === '' ? undefined : label;
}

function readSection(raw: unknown): ShellLayoutSection | undefined {
  if (!isRecord(raw)) return undefined;
  const section: ShellLayoutSection = {};
  const label = cleanLabel(raw.label);
  if (label) section.label = label;
  if (typeof raw.showTitle === 'boolean') section.showTitle = raw.showTitle;
  const icon = cleanLabel(raw.icon);
  if (icon) section.icon = icon;
  return hasKeys(section) ? section : undefined;
}

function readItem(raw: unknown): ShellLayoutItem | undefined {
  if (!isRecord(raw)) return undefined;
  const item: ShellLayoutItem = {};
  const label = cleanLabel(raw.label);
  if (label) item.label = label;
  const description = cleanLabel(raw.description);
  if (description) item.description = description;
  return hasKeys(item) ? item : undefined;
}

function readItems(
  value: unknown,
): Record<string, ShellLayoutItem> | undefined {
  if (!isRecord(value)) return undefined;
  const items: Record<string, ShellLayoutItem> = {};
  for (const [id, raw] of Object.entries(value)) {
    const item = id === '' ? undefined : readItem(raw);
    if (item) items[id] = item;
  }
  return hasKeys(items) ? items : undefined;
}

function readCustomSections(value: unknown): ShellLayoutCustomSection[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: ShellLayoutCustomSection[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue;
    const label = cleanLabel(raw.label);
    if (!raw.id.startsWith(SHELL_CUSTOM_SECTION_PREFIX) || !label) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    out.push({ id: raw.id, label });
  }
  return out;
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

  if (isRecord(input.sections)) {
    const sections: Record<string, ShellLayoutSection> = {};
    for (const [id, raw] of Object.entries(input.sections)) {
      const section = readSection(raw);
      if (section) sections[id] = section;
    }
    if (hasKeys(sections)) layout.sections = sections;
  }

  const itemOverrides = readItems(input.items);
  if (itemOverrides) layout.items = itemOverrides;

  const customSections = readCustomSections(input.customSections);
  if (customSections.length > 0) layout.customSections = customSections;

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

  const placements = readPlacements(input.placements);
  if (placements) layout.placements = placements;
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
    custom?: boolean;
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

  // User-created sections follow the host's, in creation order.
  for (const custom of readCustomSections(layout?.customSections)) {
    if (used.has(custom.id)) continue;
    used.add(custom.id);
    natives.push({
      id: custom.id,
      group: { id: custom.id, heading: custom.label, items: [] },
      items: [],
      custom: true,
    });
  }
  const overrides = isRecord(layout?.sections) ? layout.sections : {};
  const itemOverrides = readItems(layout?.items) ?? {};

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
          item: itemOverrides[entry.id]?.description
            ? {
                ...entry.item,
                description: itemOverrides[entry.id]?.description,
              }
            : entry.item,
          nativeSectionId: native.id,
          sectionId: section.id,
          hidden: hidden.has(entry.id),
          label: itemOverrides[entry.id]?.label ?? entry.item.label,
          defaultLabel: entry.item.label,
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
    const override = section.group
      ? readSection(overrides[section.id])
      : undefined;
    const custom = section.custom === true;
    return {
      id: section.id,
      group: section.group,
      heading: section.group
        ? ((custom ? undefined : override?.label) ?? section.group.heading)
        : null,
      defaultHeading: section.group && !custom ? section.group.heading : null,
      custom,
      titleVisible: section.group
        ? (override?.showTitle ?? section.group.showTitle !== false)
        : false,
      icon: section.group
        ? (override?.icon ?? section.group.icon ?? null)
        : null,
      defaultIcon: section.group?.icon ?? null,
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
      : section.items
          .filter((entry) => !entry.hidden)
          .map((e) =>
            e.label === e.defaultLabel
              ? e.item
              : { ...e.item, label: e.label, defaultLabel: e.defaultLabel },
          );

  const [root, ...sections] = model;
  const nextGroups: ShellNavGroup[] = [];
  for (const section of sections) {
    const items = visible(section);
    const group = section.group as ShellNavGroup;
    if (
      section.hidden ||
      (items.length === 0 && (section.custom || group.items.length > 0))
    ) {
      continue;
    }
    const next: ShellNavGroup = { ...group, items };
    if (section.heading !== group.heading) {
      next.id = shellNavGroupId(group);
      next.heading = section.heading as string;
    }
    if (section.titleVisible) delete next.showTitle;
    else next.showTitle = false;
    if (section.icon) next.icon = section.icon;
    nextGroups.push(next);
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
  if (hasKeys(layout.sections)) next.sections = layout.sections;
  if (hasKeys(layout.items)) next.items = layout.items;
  if (layout.customSections?.length) {
    next.customSections = layout.customSections;
  }
  if (hasKeys(layout.panels)) next.panels = layout.panels;
  if (hasKeys(layout.placements)) next.placements = layout.placements;
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
  const defaults = resolveShellNavModel(nav, groups, {
    version: SHELL_LAYOUT_VERSION,
    customSections: current.customSections,
  })
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
    customSections: current.customSections,
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
  if (!isKnownEntry(nav, groups, current, id) || current.hidden?.includes(id)) {
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
  layout: ShellLayout,
  id: string,
): boolean {
  return resolveShellNavModel(nav, groups, {
    version: SHELL_LAYOUT_VERSION,
    customSections: layout.customSections,
  }).some(
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

function setSectionOverride(
  current: ShellLayout,
  id: string,
  patch: ShellLayoutSection,
): ShellLayout {
  const sections = { ...(current.sections ?? {}) };
  const merged: ShellLayoutSection = { ...(sections[id] ?? {}), ...patch };
  if (merged.label === undefined) delete merged.label;
  if (merged.showTitle === undefined) delete merged.showTitle;
  if (merged.icon === undefined) delete merged.icon;
  if (hasKeys(merged)) sections[id] = merged;
  else delete sections[id];
  return compact({ ...current, sections });
}

function findSection(
  nav: readonly ShellNavItem[],
  groups: readonly ShellNavGroup[],
  layout: ShellLayout,
  id: string,
): ShellNavModelSection | undefined {
  return resolveShellNavModel(nav, groups, layout).find(
    (section) => section.group !== null && section.id === id,
  );
}

/**
 * Rename a section. A blank label, or the host's own heading, removes the
 * override (the section goes back to the suggested name). A custom section's
 * label is replaced outright and a blank label is ignored. Unknown ids and the
 * root section are ignored.
 */
export function renameShellSection(
  nav: readonly ShellNavItem[],
  groups: readonly ShellNavGroup[],
  layout: ShellLayout | null | undefined,
  sectionId: string,
  label: string,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  const section = findSection(nav, groups, current, sectionId);
  if (!section) return current;
  const clean = cleanLabel(label);
  if (section.custom) {
    if (!clean) return current;
    return compact({
      ...current,
      customSections: current.customSections?.map((entry) =>
        entry.id === sectionId ? { ...entry, label: clean } : entry,
      ),
    });
  }
  const reset = !clean || clean === section.defaultHeading;
  return setSectionOverride(current, sectionId, {
    label: reset ? undefined : clean,
  });
}

/**
 * Rename a navigation item. A blank label (or `null`), or the host's own
 * label, removes the override. Unknown ids are ignored. Items keep their id,
 * so a rename survives reordering and moving between sections.
 */
export function renameShellItem(
  nav: readonly ShellNavItem[],
  groups: readonly ShellNavGroup[],
  layout: ShellLayout | null | undefined,
  itemId: string,
  label: string | null,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  const entry = resolveShellNavModel(nav, groups, current)
    .flatMap((section) => section.items)
    .find((candidate) => candidate.id === itemId);
  if (!entry) return current;
  const clean = cleanLabel(label);
  const items = { ...(current.items ?? {}) };
  const kept = items[itemId]?.description;
  const next: ShellLayoutItem = {
    ...(clean && clean !== entry.defaultLabel ? { label: clean } : {}),
    ...(kept ? { description: kept } : {}),
  };
  if (hasKeys(next)) items[itemId] = next;
  else delete items[itemId];
  return compact({ ...current, items });
}

/**
 * Show or hide a section's title. Hidden titles render the items flat (the
 * shell keeps an accessible group name). Matching the host's suggestion drops
 * the override.
 */
export function setShellSectionTitleVisible(
  nav: readonly ShellNavItem[],
  groups: readonly ShellNavGroup[],
  layout: ShellLayout | null | undefined,
  sectionId: string,
  visible: boolean,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  const section = findSection(nav, groups, current, sectionId);
  if (!section) return current;
  const suggested = section.custom ? true : section.group?.showTitle !== false;
  return setSectionOverride(current, sectionId, {
    showTitle: visible === suggested ? undefined : visible,
  });
}

/**
 * Set a section's icon. A blank icon (or `null`), or the host's own icon,
 * removes the override. Works for host and custom sections; unknown ids and
 * the root section are ignored.
 */
export function setShellSectionIcon(
  nav: readonly ShellNavItem[],
  groups: readonly ShellNavGroup[],
  layout: ShellLayout | null | undefined,
  sectionId: string,
  icon: string | null,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  const section = findSection(nav, groups, current, sectionId);
  if (!section) return current;
  const clean = cleanLabel(icon);
  return setSectionOverride(current, sectionId, {
    icon: !clean || clean === section.defaultIcon ? undefined : clean,
  });
}

function slug(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'section';
}

/**
 * Create an empty user section named `label` (blank labels are ignored). It
 * gets a unique `custom:` id and lands after the existing sections; read the
 * new id from the last entry of `customSections`.
 */
export function createShellSection(
  nav: readonly ShellNavItem[],
  groups: readonly ShellNavGroup[],
  layout: ShellLayout | null | undefined,
  label: string,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  const clean = cleanLabel(label);
  if (!clean) return current;
  const used = new Set(
    resolveShellNavModel(nav, groups, current).flatMap((section) => [
      section.id,
      ...section.items.map((entry) => entry.id),
    ]),
  );
  const base = `${SHELL_CUSTOM_SECTION_PREFIX}${slug(clean)}`;
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  return compact({
    ...current,
    customSections: [...(current.customSections ?? []), { id, label: clean }],
  });
}

/**
 * Delete a user-created section. Its items return to the sections the host
 * suggested; host sections cannot be deleted (hide them instead).
 */
export function deleteShellSection(
  layout: ShellLayout | null | undefined,
  sectionId: string,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  if (!current.customSections?.some((entry) => entry.id === sectionId)) {
    return current;
  }
  const without = <T>(record: Record<string, T> | undefined) => {
    if (!record) return undefined;
    const next = { ...record };
    delete next[sectionId];
    return next;
  };
  const moved = Object.fromEntries(
    Object.entries(current.moved ?? {}).filter(
      ([, target]) => target !== sectionId,
    ),
  );
  return compact({
    ...current,
    customSections: current.customSections.filter(
      (entry) => entry.id !== sectionId,
    ),
    sectionOrder: current.sectionOrder?.filter((id) => id !== sectionId),
    itemOrder: without(current.itemOrder),
    hidden: current.hidden?.filter((id) => id !== sectionId),
    sections: without(current.sections),
    moved,
  });
}

// Slot placement of shell items (dock toggles, host items).

function readPlacements(value: unknown): Record<string, ShellSlot> | undefined {
  if (!isRecord(value)) return undefined;
  const placements: Record<string, ShellSlot> = {};
  for (const [id, slot] of Object.entries(value)) {
    if (id !== '' && isShellSlot(slot)) placements[id] = slot;
  }
  return hasKeys(placements) ? placements : undefined;
}

/**
 * Where each item lives once the layout's `placements` are applied, before any
 * hidden-region fallback. Items stay in the order given within their default
 * slot; items placed into a slot follow, in placement order. Placements for
 * ids not in `items` are ignored. Every slot is present, possibly empty.
 */
export function resolveShellPlacements(
  items: readonly ShellPlacementItem[],
  layout?: ShellLayout | null,
): Record<ShellSlot, string[]> {
  const out = Object.fromEntries(
    SHELL_SLOTS.map((slot) => [slot, [] as string[]]),
  ) as Record<ShellSlot, string[]>;
  const placements = readPlacements(layout?.placements) ?? {};
  const known = new Set<string>();
  for (const item of items) {
    if (known.has(item.id)) continue;
    known.add(item.id);
    if (placements[item.id] === undefined) out[item.slot]?.push(item.id);
  }
  for (const [id, slot] of Object.entries(placements)) {
    if (known.has(id)) out[slot].push(id);
  }
  return out;
}

/**
 * {@link resolveShellPlacements} followed by the hidden-region fallback: an
 * item whose slot's region is not `visible` moves along the slot's fallback
 * chain to the first visible slot (and is dropped only if none is visible).
 */
export function resolveShellVisiblePlacements(
  items: readonly ShellPlacementItem[],
  layout: ShellLayout | null | undefined,
  visible: (region: ShellRegion) => boolean,
): Record<ShellSlot, string[]> {
  const nominal = resolveShellPlacements(items, layout);
  const out = Object.fromEntries(
    SHELL_SLOTS.map((slot) => [slot, [] as string[]]),
  ) as Record<ShellSlot, string[]>;
  for (const slot of SHELL_SLOTS) {
    for (const id of nominal[slot]) {
      const target = resolveSlot(slot, visible);
      if (target) out[target].push(id);
    }
  }
  return out;
}

/**
 * Place an item in `slot`. Unknown slots are ignored. When `defaultSlot` (the
 * item's own default) is given and equals `slot`, the override is removed so
 * the layout stays sparse. Re-placing an item puts it last in its slot.
 */
export function placeShellItem(
  layout: ShellLayout | null | undefined,
  itemId: string,
  slot: ShellSlot,
  defaultSlot?: ShellSlot,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  if (itemId === '' || !isShellSlot(slot)) return current;
  const placements = { ...(current.placements ?? {}) };
  delete placements[itemId];
  if (slot !== defaultSlot) placements[itemId] = slot;
  return compact({ ...current, placements });
}

/** Remove an item's placement override; it returns to its default slot. */
export function resetShellItemPlacement(
  layout: ShellLayout | null | undefined,
  itemId: string,
): ShellLayout {
  const current = normalizeShellLayout(layout ?? createShellLayout());
  if (!current.placements || !(itemId in current.placements)) return current;
  const placements = { ...current.placements };
  delete placements[itemId];
  return compact({ ...current, placements });
}
