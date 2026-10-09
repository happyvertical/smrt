import {
  applyShellLayout,
  createShellSection,
  deleteShellSection,
  hideShellEntry,
  isShellLayoutEmpty,
  moveShellItem,
  moveShellSection,
  normalizeShellLayout,
  placeShellItem,
  renameShellItem,
  renameShellSection,
  resetShellItemPlacement,
  resolveShellNavModel,
  resolveShellPlacements,
  SHELL_LAYOUT_VERSION,
  type ShellLayout,
  type ShellNavModelSection,
  setShellLayoutPanel,
  setShellSectionIcon,
  setShellSectionTitleVisible,
  showShellEntry,
} from './layout.js';
import { resolveShellConfig } from './settings.js';
import {
  isShellSlot,
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
import { PANEL_EDGES } from './types.js';

export interface ShellLayoutControllerOptions {
  /** The host's flat navigation, before any layout. */
  nav: () => ShellNavItem[];
  /** The host's navigation groups, before any layout. */
  groups: () => ShellNavGroup[];
  /** The host's panel defaults, before any layout. */
  panels: () => ShellPanelDefaults | undefined;
  /** The layout currently in force (host-owned, or stored by the shell). */
  layout: () => ShellLayout | null | undefined;
  /**
   * The movable shell items (dock toggles, host items) with their default
   * slots. Omit when the shell has none.
   */
  items?: () => ShellPlacementItem[];
  /**
   * Whether in-place layout editing is offered (the host opted in). Omit for
   * "not offered": `editing` stays false and `setEditing(true)` is refused.
   */
  editable?: () => boolean;
  /** Store the next layout (and notify the host). */
  commit: (layout: ShellLayout) => void;
}

/** One edge panel as an editor presents it. */
export interface ShellLayoutPanelView {
  edge: PanelEdge;
  label: string;
  /** `false` when the host removed the panel; a layout cannot restore it. */
  available: boolean;
  visible: boolean;
  initial: 'collapsed' | 'expanded';
}

/** One movable shell item as an editor presents it. */
export interface ShellPlacementView {
  id: string;
  label: string;
  /** The slot the item lives in unless the user moved it. */
  defaultSlot: ShellSlot;
  /** The slot the layout puts it in (before any hidden-region fallback). */
  slot: ShellSlot;
  /** The user moved it away from its default slot. */
  moved: boolean;
}

const REGION_EDGE: Record<ShellRegion, PanelEdge> = {
  header: 'top',
  footer: 'bottom',
  leftSidebar: 'left',
  rightSidebar: 'right',
};

/**
 * The layout API: the same changes the `ShellLayoutEditor` makes, as plain
 * calls an assistant (or any host code) can make. Obtain it with
 * `useShellLayout()` under an `AppShell`. Every mutation returns `true` when
 * it changed the layout and `false` when it was a no-op (unknown id, already
 * in that state), so a caller can report accurately.
 */
export class ShellLayoutController {
  private editingState = $state(false);

  constructor(private readonly options: ShellLayoutControllerOptions) {}

  /** Whether in-place layout editing is offered by the host. */
  get editable(): boolean {
    return this.options.editable?.() ?? false;
  }

  /** Whether the shell is in layout edit mode (always false if not `editable`). */
  get editing(): boolean {
    return this.editable && this.editingState;
  }

  /**
   * Enter or leave layout edit mode. Returns whether the mode changed; entering
   * is refused (`false`) when the host did not opt in.
   */
  setEditing(editing: boolean): boolean {
    if (editing && !this.editable) return false;
    if (this.editingState === editing) return false;
    this.editingState = editing;
    return true;
  }

  /** The layout in force, normalized. */
  get layout(): ShellLayout {
    return normalizeShellLayout(
      this.options.layout() ?? { version: SHELL_LAYOUT_VERSION },
    );
  }

  /** Every section and item in display order, hidden ones flagged. */
  get sections(): ShellNavModelSection[] {
    return resolveShellNavModel(
      this.options.nav(),
      this.options.groups(),
      this.layout,
    );
  }

  /** The navigation as the shell renders it (hidden entries removed). */
  get applied(): { nav: ShellNavItem[]; groups: ShellNavGroup[] } {
    const { nav, groups } = applyShellLayout(
      this.options.nav(),
      this.options.groups(),
      this.options.panels(),
      this.layout,
    );
    return { nav, groups };
  }

  /** Each edge panel with its effective visibility and starting state. */
  get panels(): ShellLayoutPanelView[] {
    const defaults = resolveShellConfig(this.options.panels()).panels;
    const layout = this.layout;
    return PANEL_EDGES.map((edge) => {
      const config = defaults[edge];
      const override = layout.panels?.[edge];
      return {
        edge,
        label: config.label,
        available: config.initial !== 'hidden',
        visible: config.initial !== 'hidden' && override?.visible !== false,
        initial:
          override?.initial ??
          (config.initial === 'expanded' ? 'expanded' : 'collapsed'),
      };
    });
  }

  /** The movable shell items with their default and current slots. */
  get placementItems(): ShellPlacementView[] {
    const items = this.options.items?.() ?? [];
    const placed = resolveShellPlacements(items, this.layout);
    const slotOf = new Map<string, ShellSlot>();
    for (const [slot, ids] of Object.entries(placed)) {
      for (const id of ids) slotOf.set(id, slot as ShellSlot);
    }
    const seen = new Set<string>();
    const out: ShellPlacementView[] = [];
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const slot = slotOf.get(item.id) ?? item.slot;
      out.push({
        id: item.id,
        label: item.label,
        defaultSlot: item.slot,
        slot,
        moved: slot !== item.slot,
      });
    }
    return out;
  }

  /** Items per slot in display order (every slot present, possibly empty). */
  get placements(): Record<ShellSlot, ShellPlacementView[]> {
    const views = new Map(this.placementItems.map((view) => [view.id, view]));
    const placed = resolveShellPlacements(
      this.options.items?.() ?? [],
      this.layout,
    );
    return Object.fromEntries(
      Object.entries(placed).map(([slot, ids]) => [
        slot,
        ids.flatMap((id) => views.get(id) ?? []),
      ]),
    ) as Record<ShellSlot, ShellPlacementView[]>;
  }

  /** Whether a region is shown (its edge is available and not hidden). */
  isRegionVisible(region: ShellRegion): boolean {
    const edge = REGION_EDGE[region];
    return this.panels.find((panel) => panel.edge === edge)?.visible ?? false;
  }

  /** Whether a customization is in force. */
  get customized(): boolean {
    return !isShellLayoutEmpty(this.layout);
  }

  /** Whether a section or item is hidden by the layout. */
  isHidden(id: string): boolean {
    return this.layout.hidden?.includes(id) ?? false;
  }

  private apply(next: ShellLayout): boolean {
    const current = this.layout;
    if (JSON.stringify(next) === JSON.stringify(current)) return false;
    this.options.commit(next);
    return true;
  }

  /** Move a group section to `toIndex` among the groups (0 = first). */
  moveSection(sectionId: string, toIndex: number): boolean {
    return this.apply(
      moveShellSection(
        this.options.nav(),
        this.options.groups(),
        this.layout,
        sectionId,
        toIndex,
      ),
    );
  }

  /**
   * Move an item into a section (a group id, or `@root` for the top level) at
   * `toIndex` (default: the end).
   */
  moveItem(itemId: string, toSectionId: string, toIndex?: number): boolean {
    return this.apply(
      moveShellItem(
        this.options.nav(),
        this.options.groups(),
        this.layout,
        itemId,
        toSectionId,
        toIndex,
      ),
    );
  }

  /** Hide a section or item. */
  hide(id: string): boolean {
    return this.apply(
      hideShellEntry(
        this.options.nav(),
        this.options.groups(),
        this.layout,
        id,
      ),
    );
  }

  /** Show a hidden section or item. */
  show(id: string): boolean {
    return this.apply(showShellEntry(this.layout, id));
  }

  /** Show or hide an edge panel and/or choose the state it starts in. */
  setPanel(
    edge: PanelEdge,
    patch: { visible?: boolean; initial?: 'collapsed' | 'expanded' },
  ): boolean {
    const view = this.panels.find((panel) => panel.edge === edge);
    if (!view?.available) return false;
    return this.apply(
      setShellLayoutPanel(this.layout, edge, patch, this.options.panels()),
    );
  }

  /**
   * Rename a section (host or custom). A blank label restores the host's
   * suggested heading (custom sections ignore blank labels).
   */
  renameSection(sectionId: string, label: string): boolean {
    return this.apply(
      renameShellSection(
        this.options.nav(),
        this.options.groups(),
        this.layout,
        sectionId,
        label,
      ),
    );
  }

  /**
   * Rename a navigation item (by its id). `null` or a blank label restores
   * the host's label. Returns whether the layout changed.
   */
  renameItem(itemId: string, label: string | null): boolean {
    return this.apply(
      renameShellItem(
        this.options.nav(),
        this.options.groups(),
        this.layout,
        itemId,
        label,
      ),
    );
  }

  /**
   * Set a section's icon (a shell or host icon name). `null` or blank
   * restores the host's suggested icon.
   */
  setSectionIcon(sectionId: string, icon: string | null): boolean {
    return this.apply(
      setShellSectionIcon(
        this.options.nav(),
        this.options.groups(),
        this.layout,
        sectionId,
        icon,
      ),
    );
  }

  /** Show or hide a section's title; hidden titles render its items flat. */
  setSectionTitleVisible(sectionId: string, visible: boolean): boolean {
    return this.apply(
      setShellSectionTitleVisible(
        this.options.nav(),
        this.options.groups(),
        this.layout,
        sectionId,
        visible,
      ),
    );
  }

  /** Create an empty custom section; returns its id, or `null` when blank. */
  createSection(label: string): string | null {
    const before = this.layout.customSections?.length ?? 0;
    const next = createShellSection(
      this.options.nav(),
      this.options.groups(),
      this.layout,
      label,
    );
    if (!this.apply(next)) return null;
    // Read the id from the proposed layout: with a controlled `layout` prop
    // the host may not have applied it yet.
    const list = next.customSections ?? [];
    return list.length > before ? (list[list.length - 1]?.id ?? null) : null;
  }

  /** Delete a custom section; its items return to their default sections. */
  deleteSection(sectionId: string): boolean {
    return this.apply(deleteShellSection(this.layout, sectionId));
  }

  /**
   * Move a shell item (`dock:<tool>`, `slot:<slot>`, or a host item id) to
   * `slot`. Unknown ids and slots are no-ops. If the slot's region is hidden
   * the item still renders, via the slot's fallback chain.
   */
  placeItem(itemId: string, slot: ShellSlot): boolean {
    if (!isShellSlot(slot)) return false;
    const item = this.placementItems.find((view) => view.id === itemId);
    if (!item) return false;
    // Placing an item where it already is must not reorder it.
    if (item.slot === slot) return false;
    return this.apply(
      placeShellItem(this.layout, itemId, slot, item.defaultSlot),
    );
  }

  /** Return a shell item to its default slot. */
  resetItem(itemId: string): boolean {
    return this.apply(resetShellItemPlacement(this.layout, itemId));
  }

  /** Drop every customization. */
  reset(): boolean {
    return this.apply({ version: SHELL_LAYOUT_VERSION });
  }
}
