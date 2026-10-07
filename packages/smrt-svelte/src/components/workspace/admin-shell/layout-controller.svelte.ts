import {
  applyShellLayout,
  createShellSection,
  deleteShellSection,
  hideShellEntry,
  isShellLayoutEmpty,
  moveShellItem,
  moveShellSection,
  normalizeShellLayout,
  renameShellSection,
  resolveShellNavModel,
  SHELL_LAYOUT_VERSION,
  type ShellLayout,
  type ShellNavModelSection,
  setShellLayoutPanel,
  setShellSectionTitleVisible,
  showShellEntry,
} from './layout.js';
import { resolveShellConfig } from './settings.js';
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

/**
 * The layout API: the same changes the `ShellLayoutEditor` makes, as plain
 * calls an assistant (or any host code) can make. Obtain it with
 * `useShellLayout()` under an `AppShell`. Every mutation returns `true` when
 * it changed the layout and `false` when it was a no-op (unknown id, already
 * in that state), so a caller can report accurately.
 */
export class ShellLayoutController {
  constructor(private readonly options: ShellLayoutControllerOptions) {}

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
    const changed = this.apply(
      createShellSection(
        this.options.nav(),
        this.options.groups(),
        this.layout,
        label,
      ),
    );
    if (!changed) return null;
    const list = this.layout.customSections ?? [];
    return list.length > before ? (list[list.length - 1]?.id ?? null) : null;
  }

  /** Delete a custom section; its items return to their default sections. */
  deleteSection(sectionId: string): boolean {
    return this.apply(deleteShellSection(this.layout, sectionId));
  }

  /** Drop every customization. */
  reset(): boolean {
    return this.apply({ version: SHELL_LAYOUT_VERSION });
  }
}
