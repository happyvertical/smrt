<script lang="ts">
import {
  type ColorScheme,
  type ThemePreset,
  ThemeProvider,
} from '@happyvertical/smrt-ui/themes';
import '@happyvertical/smrt-ui/themes/styles/all.css';
import '@happyvertical/smrt-ui/themes/styles/base.css';
import '@happyvertical/smrt-ui/themes/styles/fonts.css';
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { type Component, type Snippet, tick, untrack } from 'svelte';
import { M as SORTABLE_STRINGS } from '../../i18n/strings.sortable.js';
import { M } from '../../i18n/strings.workspace.js';
import Provider from '../../Provider.svelte';
import type { User } from '../../state/app-state.js';
import type { WebMcpProviderConfig } from '../../web/webmcp-provider.js';
import { formatSortableAnnouncement } from '../sortable/announce.js';
import { createSortable } from '../sortable/controller.svelte.js';
import AdminShell from '../workspace/admin-shell/AdminShell.svelte';
import AppScopePanel from '../workspace/admin-shell/AppScopePanel.svelte';
import {
  applyShellLayout,
  normalizeShellLayout,
  resolveShellPlacements,
  type ShellLayout,
} from '../workspace/admin-shell/layout.js';
import { setShellLayout } from '../workspace/admin-shell/layout-context.js';
import { ShellLayoutController } from '../workspace/admin-shell/layout-controller.svelte.js';
import ShellBrand from '../workspace/admin-shell/ShellBrand.svelte';
import ShellIconButton from '../workspace/admin-shell/ShellIconButton.svelte';
import ShellNavEditor from '../workspace/admin-shell/ShellNavEditor.svelte';
import { resolveShellConfig } from '../workspace/admin-shell/settings.js';
import {
  SHELL_REGION_MESSAGES,
  SHELL_SLOT_MESSAGES,
  SHELL_SLOT_SHORT_MESSAGES,
} from '../workspace/admin-shell/slot-labels.js';
import {
  resolveSlot,
  SHELL_SLOTS,
  type ShellPlacementItem,
  type ShellRegion,
  type ShellSlot,
  shellDockItemId,
  shellHostSlotItemId,
  slotRegion,
} from '../workspace/admin-shell/slots.js';
import { createShellState } from '../workspace/admin-shell/state.svelte.js';
import TenantNav from '../workspace/admin-shell/TenantNav.svelte';
import {
  type AdminShellProps,
  PANEL_EDGES,
  type PanelEdge,
  type ShellNavGroup,
  type ShellNavItem,
  type ShellPanelDefaults,
  type ShellSectionActionsContext,
} from '../workspace/admin-shell/types.js';
import DockSlot from './DockSlot.svelte';
import DockToggles from './DockToggles.svelte';
import type { DockToggle } from './dock-toggle.js';
import RuntimeDiagnosticsWebMcp from './RuntimeDiagnosticsWebMcp.svelte';
import type { ShellSlotItem } from './slot-item.js';

interface Props {
  /** Application name shown in the shell brand and app panel. */
  title?: string;
  /** Secondary line under the application name in the shell brand. */
  subtitle?: string;
  /** Logo shown before the title in the shell brand (and as the compact rail mark). */
  logoSrc?: string;
  /** Alternative text for the logo (decorative by default: the title names the app). */
  logoAlt?: string;
  /** Where the brand links to (e.g. the app's home); unlinked when omitted. */
  homeHref?: string;
  /** localStorage key for the user's shell layout preferences. */
  storageKey?: string;
  /** Navigation rendered in the tenant (left) panel. */
  nav?: ShellNavItem[];
  /** Grouped navigation sections rendered below the flat `nav` items. */
  navGroups?: ShellNavGroup[];
  /** Current path, used to highlight the active link (e.g. `page.url.pathname`). */
  currentHref?: string;
  /** Tenant label shown in the app panel. */
  tenantLabel?: string;
  /** Environment badge text (e.g. `local`). */
  environment?: string;
  /** When set, the app panel links here (e.g. a settings route). */
  settingsHref?: string;
  /** Options for the Provider's WebMCP integration; passed through unchanged. */
  webmcp?: boolean | WebMcpProviderConfig;
  /** Authenticated user forwarded to the Provider; `null` renders the shell signed out. */
  user?: User | null;
  /** The user's resolved permission slugs, forwarded to the Provider for permission-gated UI. */
  permissions?: string[];
  /** Register the read-only runtime diagnostics WebMCP tool. */
  runtimeDiagnostics?: boolean;
  /** Initial panel states and presentation; forwarded to AdminShell. */
  config?: ShellPanelDefaults;
  /**
   * The user's layout customization (panel visibility, navigation order and
   * visibility), applied over `nav`, `navGroups` and `config`. Passing it
   * makes the host the owner: the shell never stores it, and reports edits
   * through `onlayoutchange` for the host to pass back. Pass `null` for "no
   * customization yet". Omit both `layout` and `onlayoutchange` to let the
   * shell keep the layout in the user's settings (`storageKey`).
   */
  layout?: ShellLayout | null;
  /** Called with the next layout whenever the user (or an assistant) edits it. */
  onlayoutchange?: (layout: ShellLayout) => void;
  /** Theme preset applied by the ThemeProvider. */
  preset?: ThemePreset;
  /** Light, dark or system color scheme; the user's persisted choice wins. */
  colorScheme?: ColorScheme;
  /** Extra app-panel content (e.g. selected-tenant notes). */
  appPanelDocs?: Snippet;
  /**
   * Dock slot, rendered inside the shell so a host can place an assistant in
   * a `ShellDockTool` without this package depending on it. It receives the
   * `DataSurfaceRegistry` of the Provider the shell mounts, the same instance
   * mounted routes register their surfaces on, so
   * `<AssistantDock {registry} />` sees them with no second registry. Routes
   * register on it when the `webmcp` UI is enabled (`webmcp: true`).
   */
  dock?: Snippet<[DataSurfaceRegistry]>;
  /**
   * Icon buttons, each placed in a shell `slot` (default `header.end`), each toggling
   * the `ShellDockTool` with the same id open and closed. `aria-pressed` and
   * `aria-expanded` follow the dock, focus moves into the dock when it
   * opens and back to the button when it closes (Escape included). The
   * `assistant` tool defaults to a chat-bubble icon. Hosts and assistants can
   * drive the same dock from code with `useShellDock()`.
   */
  dockToggles?: DockToggle[];
  /**
   * Host content for any shell slot (`header.start|center|end`,
   * `footer.start|center|end`, `leftSidebar.header|footer`,
   * `rightSidebar.header|footer`). Rendered before dock toggles placed in the
   * same slot. Each snippet is one movable item with id `slot:<slot>`; use
   * `slotItems` for individually movable content.
   */
  slots?: Partial<Record<ShellSlot, Snippet>>;
  /**
   * Host items with stable ids, each in a default slot. Users can move them
   * between slots in the layout editor (`ShellLayout.placements`). Rendered
   * after `slots` content and before dock toggles in the same slot.
   */
  slotItems?: ShellSlotItem[];
  /**
   * Opt in to editing the layout in place. Adds the built-in shell item
   * `item:layout-edit` (a pencil toggle, default slot `header.end`, or
   * `{ slot }`); while on, slots render as labelled drop zones, items and
   * navigation get grips, section headings get overlay icons and a floating
   * toolbar, and hidden regions render as strips with a show control. Hosts
   * and assistants drive it with `useShellLayout()` (`editing`,
   * `setEditing`). Off (the default) leaves existing apps unchanged.
   *
   * `{ floating: true }` instead renders the toggle as a fixed round button
   * in the top-right corner of the shell: not a placeable item (no slot, no
   * grip), so hidden regions never displace it. The header and right sidebar
   * reserve room for it so it covers none of their controls.
   */
  layoutEditing?: boolean | { slot?: ShellSlot; floating?: boolean };
  /**
   * Host icon buttons for each navigation section while the layout is edited
   * (e.g. an Options gear or Help), rendered in the section's overlay icons
   * and its floating toolbar. Receives the section id, label, whether it is
   * user-created, and `editing`.
   */
  sectionActions?: Snippet<[ShellSectionActionsContext]>;
  /**
   * `'items'` (default) lists every section's entries in the left sidebar.
   * `'sections'` lists only the sections, one icon link each, to the
   * section's own page (`ShellNavGroup.href`, else `sectionHref`, else its
   * first entry); render the entries there with `ShellSectionMenu`. In edit
   * mode the sidebar edits sections (grip, rename, hide, icon); entries are
   * edited on the section page.
   */
  navMode?: 'items' | 'sections';
  /** Section page for groups without an `href` (e.g. user-created ones). */
  sectionHref?: (sectionId: string) => string | undefined;
  /** Renders host icon names for sections and entries. */
  iconComponent?: Component<{ name: string; size?: number }>;
  /**
   * Edge toggle buttons and WASD drop-down panels (see `AdminShell`).
   * Default `false`: regions are laid out inline and no toggles or hotkeys
   * exist. Pass `true` (or a per-edge map) for the previous behaviour.
   */
  edgeToggles?: AdminShellProps['edgeToggles'];
  /** Keyboard shortcuts; default follows `edgeToggles` (see `AdminShell`). */
  hotkeys?: boolean;
  children: Snippet;
}

let {
  title = 'SMRT',
  subtitle,
  logoSrc,
  logoAlt,
  homeHref,
  storageKey = 'smrt-app-shell',
  nav = [],
  navGroups = [],
  currentHref = '',
  tenantLabel = '',
  environment = 'local',
  settingsHref,
  webmcp = false,
  user = null,
  permissions = [],
  runtimeDiagnostics = false,
  config,
  layout,
  onlayoutchange,
  preset = 'smrt',
  colorScheme = 'system',
  appPanelDocs,
  dock,
  dockToggles = [],
  slots: hostSlots,
  slotItems = [],
  layoutEditing = false,
  sectionActions,
  navMode = 'items',
  sectionHref,
  iconComponent,
  edgeToggles = false,
  hotkeys,
  children,
}: Props = $props();
/** Stable id of the built-in brand item (title, subtitle). */
const SHELL_BRAND_ITEM_ID = 'item:brand';
/** Stable id of the built-in edit-layout toggle item. */
const layoutFloating = $derived(
  typeof layoutEditing === 'object' && layoutEditing.floating === true,
);
const SHELL_LAYOUT_EDIT_ITEM_ID = 'item:layout-edit';
const { t } = useI18n();
// Every movable item, in default order: legacy `slots` snippets, `slotItems`,
// then dock toggles. Ids are stable (`slot:<slot>`, the host's id,
// `dock:<tool>`); the first of a duplicated id wins.
interface PlacedEntry extends ShellPlacementItem {
  render?: Snippet;
  toggle?: DockToggle;
  /** Stays interactive and is not draggable while the layout is edited. */
  fixed?: boolean;
}
const entries = $derived.by(() => {
  const out: PlacedEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: PlacedEntry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };
  add({
    id: SHELL_BRAND_ITEM_ID,
    label: t(M['ui.app_shell.brand_item']),
    slot: 'header.start',
    render: brandItem,
  });
  for (const slot of SHELL_SLOTS) {
    const render = hostSlots?.[slot];
    if (render) {
      add({
        id: shellHostSlotItemId(slot),
        label: t(M['ui.app_shell.slot_content'], {
          slot: t(SHELL_SLOT_MESSAGES[slot]),
        }),
        slot,
        render,
      });
    }
  }
  for (const item of slotItems) add({ ...item });
  for (const toggle of dockToggles) {
    add({
      id: shellDockItemId(toggle.tool),
      label: toggle.label,
      slot: toggle.slot ?? 'header.end',
      toggle,
    });
  }
  if (layoutEditing && !layoutFloating) {
    add({
      id: SHELL_LAYOUT_EDIT_ITEM_ID,
      label: t(M['ui.layout_edit.toggle']),
      slot:
        typeof layoutEditing === 'object'
          ? (layoutEditing.slot ?? 'header.end')
          : 'header.end',
      render: layoutToggle,
      fixed: true,
    });
  }
  return out;
});
// The shell state lives here (not inside AdminShell) so the layout can reach
// it: panel overrides apply to it, and the user's layout is stored in it when
// the host does not own persistence.
const shell = untrack(() =>
  createShellState({
    config,
    storageKey,
    layoutPanels: normalizeShellLayout(layout).panels,
  }),
);
// Hosts that pass only `onlayoutchange` own persistence but not the value:
// keep it in memory so edits show at once.
let localLayout = $state<ShellLayout | undefined>();
const controlled = $derived(layout !== undefined);
const effectiveLayout = $derived(
  normalizeShellLayout(
    controlled ? layout : onlayoutchange ? localLayout : shell.settings.layout,
  ),
);
const applied = $derived(
  applyShellLayout(nav, navGroups, config, effectiveLayout),
);
const hasNav = $derived(applied.nav.length > 0 || applied.groups.length > 0);

const slotIds = $derived(resolveShellPlacements(entries, effectiveLayout));
const entriesFor = (name: ShellSlot): PlacedEntry[] => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return slotIds[name].flatMap((id) => byId.get(id) ?? []);
};
const slotSnippets: Record<ShellSlot, Snippet> = {
  'header.start': slot_0,
  'header.center': slot_1,
  'header.end': slot_2,
  'footer.start': slot_3,
  'footer.center': slot_4,
  'footer.end': slot_5,
  'leftSidebar.header': slot_6,
  'leftSidebar.footer': slot_7,
  'rightSidebar.header': slot_8,
  'rightSidebar.footer': slot_9,
};
const shellSlots = $derived.by(() => {
  const out: Partial<Record<ShellSlot, Snippet>> = {};
  for (const name of SHELL_SLOTS) {
    if (slotIds[name].length > 0) out[name] = slotSnippets[name];
  }
  return out;
});

// Starting-state edits made through the layout API, applied once the layout
// carrying them is in force (or dropped if the host answered differently).
const pendingStart = new Map<PanelEdge, 'collapsed' | 'expanded'>();
$effect(() => {
  const panels = effectiveLayout.panels ?? {};
  shell.setLayoutPanels(panels);
  for (const [edge, state] of pendingStart) {
    const initial =
      panels[edge]?.initial ?? resolveShellConfig(config).panels[edge].initial;
    if (initial === state) shell.setPanelStart(edge, state);
  }
  pendingStart.clear();
});

const layoutApi = new ShellLayoutController({
  editable: () => !!layoutEditing,
  nav: () => nav,
  groups: () => navGroups,
  panels: () => config,
  layout: () => effectiveLayout,
  items: () => entries.map(({ id, label, slot }) => ({ id, label, slot })),
  commit(next) {
    // A changed starting state is an explicit edit: show it now. It waits
    // for the layout to actually change (the host may reject the edit) and
    // is never done for a loaded layout (hydration, a late `layout` prop),
    // so loading cannot erase the user's own open/closed toggle.
    for (const edge of PANEL_EDGES) {
      const before = effectiveLayout.panels?.[edge]?.initial;
      const after = next.panels?.[edge]?.initial;
      if (before === after) continue;
      const state = after ?? resolveShellConfig(config).panels[edge].initial;
      if (state === 'collapsed' || state === 'expanded') {
        pendingStart.set(edge, state);
      }
    }
    if (!controlled) {
      if (onlayoutchange) localLayout = next;
      else shell.setLayout(next);
    }
    onlayoutchange?.(next);
  },
});
setShellLayout(layoutApi);

// ---- In-place layout editing -------------------------------------------
const editing = $derived(layoutApi.editing);
let shellRoot = $state<HTMLElement | undefined>();
// The floating toggle sits over the header's end (header visible), the top of
// the right sidebar (header hidden) or the top of main (neither); reserve that room so it covers no
// control. AdminShell reads these custom properties.
const floatingReserve = $derived.by(() => {
  if (!layoutFloating) return undefined;
  const size = 'calc(2.75rem + var(--smrt-spacing-3))';
  const headerShown = shell.isRegionVisible('header');
  // Header hidden: the button sits over whichever region is topmost at the
  // right edge: the right sidebar when shown, otherwise the main content.
  const sidebarShown = shell.isEdgeShown('right');
  return {
    inline: headerShown ? size : '0px',
    block: !headerShown && sidebarShown ? size : '0px',
    main: !headerShown && !sidebarShown ? size : '0px',
  };
});
let modeMessage = $state('');
let wasEditing = false;
$effect(() => {
  const now = editing;
  if (now === wasEditing) return;
  wasEditing = now;
  modeMessage = t(
    now ? M['ui.layout_edit.announce_on'] : M['ui.layout_edit.announce_off'],
  );
});

/** Visual (row-major) order of the drop zones, which is also the keyboard order. */
const ZONE_ORDER: readonly ShellSlot[] = [
  'header.start',
  'header.center',
  'header.end',
  'leftSidebar.header',
  'rightSidebar.header',
  'leftSidebar.footer',
  'rightSidebar.footer',
  'footer.start',
  'footer.center',
  'footer.end',
];
const regionVisible = (region: ShellRegion): boolean =>
  shell.isRegionVisible(region);
const zones = $derived(
  ZONE_ORDER.filter((slot) => regionVisible(slotRegion(slot))),
);
function zoneLabel(slot: ShellSlot): string {
  return t(M['ui.layout_edit.zone'], {
    region: t(SHELL_REGION_MESSAGES[slotRegion(slot)]),
    slot: t(SHELL_SLOT_SHORT_MESSAGES[slot]),
  });
}
// Items shown in a zone: those placed there, then those that fall back to it
// because their own region is hidden or collapsed.
function zoneEntries(zone: ShellSlot): PlacedEntry[] {
  const own = entriesFor(zone);
  const fallen = SHELL_SLOTS.filter(
    (name) => name !== zone && resolveSlot(name, regionVisible) === zone,
  ).flatMap((name) => entriesFor(name));
  return [...own, ...fallen];
}
const movableIn = (zone: string): PlacedEntry[] =>
  zoneEntries(zone as ShellSlot).filter((entry) => !entry.fixed);

const slotSortable = createSortable({
  root: () => shellRoot,
  selectors: {
    container: '[data-smrt-edit-zone]',
    containerKey: 'smrtEditZone',
    item: '[data-smrt-edit-item]',
    itemKey: 'smrtEditItem',
  },
  containers: () => zones.map((slot) => ({ id: slot, label: zoneLabel(slot) })),
  itemIds: (zone) => movableIn(zone).map((entry) => entry.id),
  itemLabel: (id) =>
    entries.find((entry) => entry.id === id && !entry.fixed)?.label,
  allowSameContainerReorder: () => false,
  enabled: () => editing,
  orientation: () => 'vertical',
  announce: (announcement) => formatSortableAnnouncement(t, announcement),
  focusTarget: (element) =>
    element.querySelector<HTMLElement>('[data-smrt-edit-handle]'),
  commit(move) {
    layoutApi.placeItem(move.itemId, move.target.containerId as ShellSlot);
  },
});

// Native HTML drag has no per-zone listeners (the zones belong to AdminShell):
// delegate from the shell root.
$effect(() => {
  const root = shellRoot;
  if (!root || !editing) return;
  const over = (event: DragEvent) => {
    if (slotSortable.drag) event.preventDefault();
  };
  const drop = (event: DragEvent) => {
    if (!slotSortable.drag || !(event.target instanceof Element)) return;
    const zone = event.target.closest<HTMLElement>('[data-smrt-edit-zone]');
    if (zone?.dataset.smrtEditZone) {
      slotSortable.dropOnContainer(event, zone.dataset.smrtEditZone);
    }
  };
  root.addEventListener('dragover', over);
  root.addEventListener('drop', drop);
  return () => {
    root.removeEventListener('dragover', over);
    root.removeEventListener('drop', drop);
  };
});

const REGION_OF_EDGE: Record<PanelEdge, ShellRegion> = {
  top: 'header',
  bottom: 'footer',
  left: 'leftSidebar',
  right: 'rightSidebar',
};
const hiddenRegions = $derived(
  layoutApi.panels
    .filter((panel) => panel.available && !panel.visible)
    .map((panel) => REGION_OF_EDGE[panel.edge]),
);
const editSurface = $derived({
  active: editing,
  highlight:
    (slotSortable.drag?.target.containerId as ShellSlot | undefined) ?? null,
  zone: editZone,
  hiddenRegions,
  strip: editStrip,
  regionControl: editRegionControl,
});
const visibleRegionCount = $derived(
  layoutApi.panels.filter((panel) => panel.available && panel.visible).length,
);

// Editing reveals every shown sidebar so its header/footer drop zones exist
// (a collapsed one only has a rail); leaving restores what was collapsed.
// A railless edge (`rail: false`) is left as the user has it: closed stays
// closed (AdminShell offers an indicator tab to open it while editing).
let revealedByEdit: ('left' | 'right')[] = [];
$effect(() => {
  if (editing) {
    untrack(() => {
      if (shell.viewport === 'phone') return;
      for (const edge of ['left', 'right'] as const) {
        if (shell.config.panels[edge].rail === false) continue;
        // Opened for now only: nothing is saved, so the user's own panel
        // state survives edit mode, a reload and a page unload.
        if (shell.revealPanelTemporarily(edge)) revealedByEdit.push(edge);
      }
    });
    return;
  }
  untrack(() => {
    for (const edge of revealedByEdit) shell.endTemporaryReveal(edge);
    revealedByEdit = [];
  });
});

// Escape leaves edit mode, unless it is cancelling something first: a section
// toolbar (closed by ShellNavEditor, which marks the event handled) or a
// keyboard move in progress.
$effect(() => {
  if (!editing) return;
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (slotSortable.drag) return;
    if (shellRoot?.querySelector('[data-toolbar-open]')) return;
    layoutApi.setEditing(false);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
});

async function toggleEditing(): Promise<void> {
  layoutApi.setEditing(!layoutApi.editing);
  await tick();
}
const EDGE_OF_REGION: Record<ShellRegion, PanelEdge> = {
  header: 'top',
  footer: 'bottom',
  leftSidebar: 'left',
  rightSidebar: 'right',
};
</script>

{#snippet slotBody(name: ShellSlot)}
  {#each entriesFor(name) as entry (entry.id)}
    {#if entry.toggle}
      <DockToggles toggles={[entry.toggle]} />
    {:else if entry.render}
      {@render entry.render()}
    {/if}
  {/each}
{/snippet}
{#snippet slot_0()}
  {@render slotBody('header.start')}
{/snippet}
{#snippet slot_1()}
  {@render slotBody('header.center')}
{/snippet}
{#snippet slot_2()}
  {@render slotBody('header.end')}
{/snippet}
{#snippet slot_3()}
  {@render slotBody('footer.start')}
{/snippet}
{#snippet slot_4()}
  {@render slotBody('footer.center')}
{/snippet}
{#snippet slot_5()}
  {@render slotBody('footer.end')}
{/snippet}
{#snippet slot_6()}
  {@render slotBody('leftSidebar.header')}
{/snippet}
{#snippet slot_7()}
  {@render slotBody('leftSidebar.footer')}
{/snippet}
{#snippet slot_8()}
  {@render slotBody('rightSidebar.header')}
{/snippet}
{#snippet slot_9()}
  {@render slotBody('rightSidebar.footer')}
{/snippet}

{#snippet layoutToggle()}
  <span class="smrt-layout-toggle" class:smrt-layout-toggle--floating={layoutFloating} data-testid="layout-edit-toggle">
    <ShellIconButton
      icon="edit"
      pressed={editing}
      label={t(M['ui.layout_edit.toggle'])}
      tooltip={t(M['ui.layout_edit.toggle'])}
      onclick={toggleEditing}
    />
  </span>
{/snippet}

{#snippet entryBody(entry: PlacedEntry)}
  {#if entry.toggle}
    <DockToggles toggles={[entry.toggle]} />
  {:else if entry.render}
    {@render entry.render()}
  {/if}
{/snippet}

{#snippet editZone(slot: ShellSlot)}
  <span class="smrt-edit-zone__label">{zoneLabel(slot)}</span>
  {#each zoneEntries(slot) as entry (entry.id)}
    {#if entry.fixed}
      {@render entryBody(entry)}
    {:else}
      {@const dragging = slotSortable.drag?.itemId === entry.id}
      <span
        class="smrt-edit-item"
        class:smrt-edit-item--dragging={dragging}
        data-smrt-edit-item={entry.id}
      >
        <!-- raw-primitive-allow: native button owns keyboard pickup and HTML drag/drop -->
        <button
          type="button"
          class="smrt-edit-item__grip"
          data-smrt-edit-handle=""
          draggable={slotSortable.nativeDraggable}
          aria-label={t(SORTABLE_STRINGS['ui.sortable.move'], { item: entry.label })}
          title={t(SORTABLE_STRINGS['ui.sortable.move'], { item: entry.label })}
          aria-pressed={dragging}
          onclick={() => slotSortable.consumeClick(entry.id)}
          onkeydown={(event) => slotSortable.keydown(event, entry.id)}
          onblur={(event) => slotSortable.blur(event, entry.id)}
          onpointerdown={(event) => slotSortable.pointerDown(event, entry.id)}
          onpointermove={(event) => slotSortable.pointerMove(event)}
          onpointerup={(event) => slotSortable.pointerUp(event)}
          onpointercancel={(event) => slotSortable.pointerCancel(event)}
          ondragstart={(event) => slotSortable.dragStart(event, entry.id)}
          ondragend={() => slotSortable.dragEnd()}
        ><span aria-hidden="true">⠿</span></button>
        <span class="smrt-edit-item__body" inert>{@render entryBody(entry)}</span>
      </span>
    {/if}
  {/each}
{/snippet}

{#snippet brandItem()}
  <ShellBrand {title} {subtitle} {logoSrc} {logoAlt} {homeHref} />
{/snippet}

{#snippet editRegionControl(region: ShellRegion)}
  {@const label = t(SHELL_REGION_MESSAGES[region])}
  {@const last = visibleRegionCount <= 1}
  <ShellIconButton
    icon="eyeOff"
    size={16}
    disabled={last}
    label={t(M['ui.layout_edit.hide_region'], { region: label })}
    tooltip={last
      ? t(M['ui.layout_edit.hide_last_region'], { region: label })
      : t(M['ui.layout_edit.hide_region'], { region: label })}
    onclick={() => layoutApi.setPanel(EDGE_OF_REGION[region], { visible: false })}
  />
{/snippet}

{#snippet editStrip(region: ShellRegion)}
  {@const label = t(SHELL_REGION_MESSAGES[region])}
  <span>{t(M['ui.layout_edit.region_hidden'], { region: label })}</span>
  <ShellIconButton
    icon="eye"
    size={16}
    label={t(M['ui.layout_edit.show_region'], { region: label })}
    onclick={() => layoutApi.setPanel(EDGE_OF_REGION[region], { visible: true })}
  />
{/snippet}

<Provider {webmcp} {user} {permissions}>
  <RuntimeDiagnosticsWebMcp enabled={runtimeDiagnostics} />
  <ThemeProvider {preset} {colorScheme} persist={true}>
    <AdminShell
      {title}
      {subtitle}
      {logoSrc}
      {logoAlt}
      {homeHref}
      state={shell}
      path={currentHref}
      slots={shellSlots}
      layoutEdit={editSurface}
      {edgeToggles}
      {hotkeys}
      brandInSlot
      bind:rootElement={shellRoot}
      {floatingReserve}
    >
      {#snippet appPanel()}
        <AppScopePanel
          appName={title}
          tenantName={tenantLabel}
          {environment}
          showSettings={false}
        >
          {#snippet docs()}
            {@render appPanelDocs?.()}
            {#if settingsHref}
              <a href={settingsHref}>{t(M['ui.app_shell.settings_link'])}</a>
            {/if}
          {/snippet}
        </AppScopePanel>
      {/snippet}

      {#snippet tenantRail()}
        {#if navMode === 'sections' && !editing && hasNav}
          <TenantNav
            collapsed
            items={applied.nav}
            groups={applied.groups}
            {currentHref}
            {navMode}
            {sectionHref}
            {iconComponent}
            aria-label={t(M['ui.app_shell.navigation'])}
          />
        {/if}
      {/snippet}

      {#snippet tenantPanel()}
        {#if editing}
          <ShellNavEditor
            aria-label={t(M['ui.app_shell.navigation'])}
            {sectionActions}
            {navMode}
            {iconComponent}
          />
        {:else if hasNav}
          <TenantNav
            items={applied.nav}
            groups={applied.groups}
            {currentHref}
            {navMode}
            {sectionHref}
            {iconComponent}
            aria-label={t(M['ui.app_shell.navigation'])}
          />
        {/if}
      {/snippet}

      <div class="smrt-layout-live" role="status" aria-live="polite">{modeMessage}</div>
      {#if editing}
        <div class="smrt-layout-live" aria-live="assertive" aria-atomic="true">{slotSortable.announcement}</div>
      {/if}
      {#if layoutFloating}
        {@render layoutToggle()}
      {/if}
      {#if dock}
        <DockSlot {dock} />
      {/if}
      {@render children()}
    </AdminShell>
  </ThemeProvider>
</Provider>

<style>
  a {
    color: var(--smrt-color-primary);
  }
  .smrt-layout-toggle { display: inline-flex; align-items: center; gap: var(--smrt-spacing-1); }
  .smrt-layout-toggle--floating { position: fixed; z-index: 45; inset-block-start: max(var(--smrt-spacing-3), env(safe-area-inset-top)); inset-inline-end: max(var(--smrt-spacing-3), env(safe-area-inset-right)); border-radius: var(--smrt-radius-full); background: var(--smrt-color-surface-container-high); box-shadow: var(--smrt-elevation-2); }
  .smrt-layout-toggle--floating :global(.smrt-shell-icon-button) { border-radius: var(--smrt-radius-full); }
  .smrt-layout-toggle :global(.smrt-shell-icon-button[aria-pressed='true']) { background: var(--smrt-color-primary-container); color: var(--smrt-color-on-primary-container); }
  .smrt-layout-live { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  .smrt-edit-zone__label { flex: 0 0 auto; color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-label-small-font); white-space: nowrap; }
  .smrt-edit-item { display: inline-flex; align-items: center; min-inline-size: 0; border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); background: var(--smrt-color-surface); }
  .smrt-edit-item--dragging { opacity: 0.55; }
  .smrt-edit-item__body { display: inline-flex; align-items: center; min-inline-size: 0; pointer-events: none; }
  .smrt-edit-item__grip { display: inline-grid; place-items: center; flex: 0 0 auto; inline-size: 1.5rem; block-size: 2rem; padding: 0; border: 0; border-radius: var(--smrt-radius-sm); background: transparent; color: var(--smrt-color-on-surface-variant); cursor: grab; touch-action: none; }
  .smrt-edit-item__grip:hover { background: var(--smrt-color-surface-container-high); }
  .smrt-edit-item__grip:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .smrt-edit-item__grip[aria-pressed='true'] { background: var(--smrt-color-primary-container); color: var(--smrt-color-on-primary-container); }
</style>
