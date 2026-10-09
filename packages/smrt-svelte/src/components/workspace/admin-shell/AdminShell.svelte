<script lang="ts" module>
import type { ShellState as ModuleShellState } from './state.svelte.js';
import type { PanelEdge as ModulePanelEdge } from './types.js';

function expandedSize(shell: ModuleShellState, edge: ModulePanelEdge): string {
  const resized = shell.panelSize(edge);
  return resized !== null
    ? `${resized}px`
    : shell.config.panels[edge].expandedSize;
}

function trackFor(shell: ModuleShellState, edge: ModulePanelEdge): string {
  const state = shell.panels[edge];
  if (state === 'hidden') return '0rem';
  if (state === 'collapsed') return collapsedSize(shell, edge);
  if (shell.presentationFor(edge) === 'overlay')
    return collapsedSize(shell, edge);
  return expandedSize(shell, edge);
}

function collapsedSize(shell: ModuleShellState, edge: ModulePanelEdge): string {
  if (shell.panels[edge] === 'hidden') return '0rem';
  const config = shell.config.panels[edge];
  // A railless edge has nothing to show while closed.
  if (config.rail === false) return '0rem';
  return config.collapsedSize;
}

function buildLayoutStyle(shell: ModuleShellState): string {
  return [
    `--smrt-admin-shell-left-track: ${trackFor(shell, 'left')}`,
    `--smrt-admin-shell-right-track: ${trackFor(shell, 'right')}`,
    `--smrt-admin-shell-top-track: ${trackFor(shell, 'top')}`,
    `--smrt-admin-shell-bottom-track: ${trackFor(shell, 'bottom')}`,
    `--smrt-admin-shell-left-collapsed: ${collapsedSize(shell, 'left')}`,
    `--smrt-admin-shell-right-collapsed: ${collapsedSize(shell, 'right')}`,
    `--smrt-admin-shell-left-expanded: ${expandedSize(shell, 'left')}`,
    `--smrt-admin-shell-right-expanded: ${expandedSize(shell, 'right')}`,
    `--smrt-admin-shell-top-expanded: ${expandedSize(shell, 'top')}`,
    `--smrt-admin-shell-bottom-expanded: ${expandedSize(shell, 'bottom')}`,
  ].join('; ');
}
</script>

<script lang="ts">
  import { swipeDismiss } from '@happyvertical/smrt-ui/feedback';
  import { useI18n } from '@happyvertical/smrt-ui/i18n';
  import { Button } from '@happyvertical/smrt-ui/ui';
  import { onMount, tick, untrack } from 'svelte';
  import type { Snippet } from 'svelte';
  import { M } from '../../../i18n/strings.workspace.js';
  import ActivityBadge from './ActivityBadge.svelte';
  import ShellBrand from './ShellBrand.svelte';
  import { setAdminShell } from './context.js';
  import {
    formatHotkeyBinding,
    shellActionFromKeyboardEvent,
  } from './hotkeys.js';
  import { type BottomBarMode, bottomBarMode } from './mobile-shell.js';
  import {
    installKeyboardWatcher,
    installScrollChrome,
    installShellOverlayMedia,
    installShellViewport,
    watchFormActionBar,
  } from './mobile-shell-dom.js';
  import { clampPanelSize, resolveHotkey } from './settings.js';
  import { createShellState, type ShellState } from './state.svelte.js';
  import {
    resolveSlot,
    type ShellRegion,
    type ShellSlot,
    slotRegion,
  } from './slots.js';
  import type {
    AdminShellPhoneOptions,
    AdminShellProps,
    PanelEdge,
    ShellLayoutEditSurface,
    ShellFocusTool,
    ShellViewport,
  } from './types.js';

  interface Props extends AdminShellProps {
    /** Pre-configured shell state. Creates one from config if omitted. */
    state?: ShellState;
    /** Content for the top app bar. */
    appBar?: Snippet;
    /** Account content kept in the app bar in every left-panel state. */
    account?: Snippet;
    /** Content for the main app panel. */
    appPanel?: Snippet;
    /** Content for the left tenant rail. */
    tenantRail?: Snippet;
    /** Content pinned below the collapsed tenant rail. */
    tenantRailFooter?: Snippet;
    /** Content for the left tenant panel. */
    tenantPanel?: Snippet;
    /**
     * Host content for the region slots (`header.start|center|end`,
     * `footer.start|center|end`, `leftSidebar.header|footer`,
     * `rightSidebar.header|footer`). A slot whose region is not visible moves
     * along its documented fallback chain (see `slotFallbackChain`).
     */
    slots?: Partial<Record<ShellSlot, Snippet>>;
    /**
     * In-place layout editing (`AppShell` supplies it): while `active`,
     * slots render as drop zones and hidden regions as strips.
     */
    layoutEdit?: ShellLayoutEditSurface;
    /** The shell's root element (bindable), e.g. to confine drag hit-testing. */
    rootElement?: HTMLElement;
    /**
     * Room kept clear for a floating control (AppShell's floating layout
     * toggle): CSS lengths for the header's end, the right sidebar's top and
     * main's top. Part of the root's style so re-renders never drop it.
     */
    floatingReserve?: { inline?: string; block?: string; main?: string };
    /** Content for the tenant panel footer. */
    tenantFooter?: Snippet;
    /** Content for the right focus rail. */
    focusRail?: Snippet;
    /** Content for the right focus panel, receives the active tool. */
    focusPanel?: Snippet<[{ tool: ShellFocusTool | null }]>;
    /**
     * Content for the system bar. When supplied without a `systemPanel` it owns
     * the bottom band: there is nothing to open, so no bottom toggle is drawn.
     */
    systemBar?: Snippet;
    /** Content for the system panel. */
    systemPanel?: Snippet;
    /** Content for the top-left corner. */
    topLeftCorner?: Snippet;
    /** Content for the top-right corner. */
    topRightCorner?: Snippet;
    /** Content for the bottom-left corner. */
    bottomLeftCorner?: Snippet;
    /** Content for the bottom-right corner. */
    bottomRightCorner?: Snippet;
    /** Content for the keyboard shortcuts overlay. */
    shortcutsOverlay?: Snippet;
    /**
     * A full-width header row above every edge (`#smrt-admin-shell-header`,
     * 3.5rem; override `--smrt-admin-shell-header-size`). Shown at every
     * width except on phones when `phoneTopBar` is given.
     */
    header?: Snippet<[{ viewport: ShellViewport }]>;
    /**
     * Phone-only context bar over the top of the main region. Hides while
     * scrolling down and returns on the first scroll up (see
     * `phone.hideOnScroll`); pinned while `pinChrome` or a drawer is open.
     * Mark an actual replacement title with `data-shell-page-title-replacement`
     * to visually hide the corresponding PageHeader title. Action-only or
     * workspace-name bars leave the page heading visible. Mark replacement
     * back navigation with `data-shell-page-navigation-replacement` to hide
     * PageHeader breadcrumbs; a title alone does not replace navigation.
     */
    phoneTopBar?: Snippet<[{ hidden: boolean }]>;
    /**
     * Phone-only bottom bar row. Replaced by a form's action bar
     * (`[data-form-action-bar]` inside main) and hidden while the on-screen
     * keyboard is open.
     */
    phoneBottomBar?: Snippet;
    /**
     * Host surfaces laid over the shell above the phone bottom bar (phone
     * sheets, status strips). The layer ignores pointer events; its direct
     * children receive them.
     */
    overlays?: Snippet<[{ viewport: ShellViewport; bottomBar: BottomBarMode }]>;
    /** Phone behavior switches (scrim, swipe to close, hide on scroll). */
    phone?: AdminShellPhoneOptions;
    /** Keep the phone top bar shown (e.g. while a banner is visible). */
    pinChrome?: boolean;
    /**
     * Current location. When it changes on a phone, open side drawers and
     * sheets close and the phone top bar comes back.
     */
    path?: string;
    children: Snippet;
  }

  let {
    title = 'SMRT',
    homeHref,
    showTenantToggle,
    edgeToggles = false,
    hotkeys,
    brandInSlot = false,
    logoSrc,
    logoAlt = '',
    brand,
    subtitle = '',
    config,
    settings,
    settingsAdapter,
    storageKey = 'smrt-admin-shell',
    state: providedState,
    appBar,
    account,
    appPanel,
    tenantRail,
    tenantRailFooter,
    tenantPanel,
    tenantFooter,
    slots,
    layoutEdit,
    rootElement = $bindable(),
    floatingReserve,
    focusRail,
    focusPanel,
    systemBar,
    systemPanel,
    topLeftCorner,
    topRightCorner,
    bottomLeftCorner,
    bottomRightCorner,
    shortcutsOverlay,
    header,
    phoneTopBar,
    phoneBottomBar,
    overlays,
    phone,
    pinChrome = false,
    path,
    children,
  }: Props = $props();

  const { t } = useI18n();
  const shell = untrack(
    () =>
      providedState ??
      createShellState({
        config,
        settings,
        settingsAdapter,
        storageKey,
      }),
  );
  setAdminShell(shell);

  let shortcutsOpen = $state(false);
  function resolveActiveFocusTool(): ShellFocusTool | null {
    return (
      shell.focusTools.find((tool) => tool.id === shell.activeFocusToolId) ??
      shell.focusTools[0] ??
      null
    );
  }
  const shortcutEdges: PanelEdge[] = ['top', 'left', 'bottom', 'right'];

  const SIDE_EDGES = ['left', 'right'] as const;
  type SideEdge = (typeof SIDE_EDGES)[number];

  let mainElement: HTMLElement | undefined = $state();
  let keyboardOpen = $state(false);
  let formActions = $state(false);
  let chromeHidden = $state(false);
  let resizing = $state<SideEdge | null>(null);
  const sideElements = $state<Partial<Record<SideEdge, HTMLElement>>>({});
  let scrollChrome: ReturnType<typeof installScrollChrome> | null = null;

  const viewport = $derived(shell.viewport);
  const isPhone = $derived(viewport === 'phone');
  const narrow = $derived(shell.viewport === 'phone');
  $effect(() => {
    const panel = sideElements.left;
    if (!narrow || !edgeExpanded('left') || !panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    void tick().then(async () => {
      // Inherited visibility also transitions on primitive buttons; wait for
      // the drawer and its controls to be focusable before moving focus.
      const animations = panel.getAnimations?.({ subtree: true }) ?? [];
      await Promise.all(animations
        .filter((animation) => animation.playState !== 'paused' && Number.isFinite(animation.effect?.getComputedTiming().endTime ?? 0))
        .map((animation) => animation.finished.catch(() => {})));
      if (cancelled || !narrow || !edgeExpanded('left') || !panel.isConnected) return;
      panel.querySelector<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus();
    });
    return () => { cancelled = true; queueMicrotask(() => { if (opener?.isConnected) opener.focus(); }); };
  });
  const showDefaultPhoneTenantOpener = $derived(
    isPhone &&
      !phoneTopBar &&
      panelState('top') === 'hidden' &&
      shell.isEdgeShown('left') &&
      shell.phonePresentation('left') !== 'hidden',
  );
  const showPhoneTop = $derived(
    isPhone && (Boolean(phoneTopBar) || showDefaultPhoneTenantOpener),
  );
  const showHeader = $derived(
    Boolean(header) && !(isPhone && Boolean(phoneTopBar)),
  );
  const bottomBar = $derived<BottomBarMode>(
    isPhone && phoneBottomBar
      ? bottomBarMode({ formActions, keyboardOpen })
      : 'none',
  );
  const phoneSurfaceOpen = $derived(
    isPhone &&
      SIDE_EDGES.some(
        (edge) => panelState(edge) === 'expanded' && shell.isEdgeShown(edge),
      ),
  );
  const reserveStyle = $derived(
    [
      `--smrt-shell-floating-reserve-inline: ${floatingReserve?.inline ?? '0px'}`,
      `--smrt-shell-floating-reserve-block: ${floatingReserve?.block ?? '0px'}`,
      `--smrt-shell-floating-reserve-main: ${floatingReserve?.main ?? '0px'}`,
    ].join('; '),
  );
  const chromeStyle = $derived(
    [
      `--smrt-admin-shell-header-track: ${showHeader ? 'var(--smrt-admin-shell-header-size)' : '0rem'}`,
      `--smrt-admin-shell-phone-bar-track: ${bottomBar === 'nav' ? 'var(--smrt-admin-shell-phone-bar-size)' : '0rem'}`,
    ].join('; '),
  );

  /**
   * Tablet/desktop: the side edge that is open as an overlay (its
   * `overlayMedia` matches), laid over the page above a scrim.
   */
  const overlayEdge = $derived<SideEdge | null>(
    isPhone
      ? null
      : (SIDE_EDGES.find(
          (edge) =>
            panelState(edge) === 'expanded' &&
            shell.isEdgeShown(edge) &&
            shell.presentationFor(edge) === 'overlay',
        ) ?? null),
  );

  // An overlay takes focus when it opens (unless something inside already
  // has it) and hands it back to whatever opened it when it closes.
  let overlayReturnFocus: HTMLElement | null = null;
  let lastOverlayEdge: SideEdge | null = null;
  /**
   * An overlay that was just closed and is sliding back out: it keeps its
   * expanded look (inert, above a fading scrim) until the animation ends.
   */
  let closingEdge = $state<SideEdge | null>(null);
  let closingTimer: ReturnType<typeof setTimeout> | null = null;

  function endClosing(): void {
    if (closingTimer) clearTimeout(closingTimer);
    closingTimer = null;
    closingEdge = null;
  }

  function prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /** An edge shown open: expanded, or an overlay still sliding out. */
  function shownOpen(edge: PanelEdge): boolean {
    return edgeExpanded(edge) || closingEdge === edge;
  }

  $effect(() => {
    const edge = overlayEdge;
    untrack(() => {
      if (edge === lastOverlayEdge) return;
      const previous = lastOverlayEdge;
      lastOverlayEdge = edge;
      if (typeof document === 'undefined') return;
      if (edge) {
        endClosing();
        const active = document.activeElement;
        overlayReturnFocus =
          active instanceof HTMLElement && active !== document.body
            ? active
            : null;
        // Effects run after the DOM update, so the panel is already shown.
        const panel = sideElements[edge];
        if (panel && !panel.contains(document.activeElement)) {
          panel.focus({ preventScroll: true });
        }
        return;
      }
      const panel = previous ? sideElements[previous] : undefined;
      const active = document.activeElement;
      const lost =
        !active || active === document.body || Boolean(panel?.contains(active));
      if (lost && overlayReturnFocus?.isConnected) {
        overlayReturnFocus.focus({ preventScroll: true });
      }
      overlayReturnFocus = null;
      // Closed (not just docked by a wider window): slide back out.
      if (
        previous &&
        panelState(previous) !== 'expanded' &&
        shell.presentationFor(previous) === 'overlay' &&
        !isPhone &&
        !prefersReducedMotion()
      ) {
        endClosing();
        closingEdge = previous;
        // Fallback when animationend never fires (hidden tab, no CSS).
        closingTimer = setTimeout(endClosing, 600);
      }
    });
  });

  // Dock opened from code (`useShellDock`, header dock toggles): focus moves
  // into the dock once it is shown.
  let lastDockFocusRequest = 0;
  $effect(() => {
    const request = shell.dockFocusRequest;
    untrack(() => {
      if (request === lastDockFocusRequest) return;
      lastDockFocusRequest = request;
      void tick().then(focusDock);
    });
  });

  function focusDock(): void {
    const aside = sideElements.right;
    const panel = aside?.querySelector<HTMLElement>(
      '.smrt-admin-shell__panel--right',
    );
    if (!panel || panel.hidden || !edgeExpanded('right')) return;
    if (panel.contains(document.activeElement)) return;
    const target =
      panel.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
      ) ?? panel;
    target.focus({ preventScroll: true });
  }

  // When the dock closes (Escape, a toggle, or code), focus goes back to
  // where it was opened from if it was left inside the dock or lost.
  let dockWasOpen = false;
  $effect(() => {
    const open = edgeExpanded('right');
    untrack(() => {
      const wasOpen = dockWasOpen;
      dockWasOpen = open;
      if (!wasOpen || open) return;
      const target = shell.dockReturnFocus;
      shell.dockReturnFocus = null;
      if (!target?.isConnected || typeof document === 'undefined') return;
      const active = document.activeElement;
      const lost =
        !active ||
        active === document.body ||
        Boolean(sideElements.right?.contains(active));
      if (lost) target.focus({ preventScroll: true });
    });
  });

  function onEdgeAnimationEnd(event: AnimationEvent, edge: SideEdge): void {
    if (closingEdge === edge && event.target === event.currentTarget) {
      endClosing();
    }
  }

  function collapsePhoneSurfaces(): void {
    for (const edge of SIDE_EDGES) {
      if (panelState(edge) === 'expanded' && shell.isEdgeShown(edge)) {
        shell.collapsePanel(edge);
      }
    }
  }

  onMount(() => {
    const offViewport = installShellViewport(shell);
    const offOverlayMedia = installShellOverlayMedia(shell);
    void shell.hydrate().then(() => shell.closeOverlaidEdges());
    const offKeyboard = phoneBottomBar
      ? installKeyboardWatcher((open) => (keyboardOpen = open))
      : () => {};
    const offFormActions =
      phoneBottomBar && mainElement
        ? watchFormActionBar(mainElement, (present) => (formActions = present))
        : () => {};
    scrollChrome =
      phoneTopBar && phone?.hideOnScroll !== false && mainElement
        ? installScrollChrome(mainElement, {
            onChange: (hidden) => (chromeHidden = hidden),
            isPinned: () =>
              pinChrome || phoneSurfaceOpen || shell.viewport !== 'phone',
          })
        : null;

    function handleKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        if (shortcutsOpen) {
          shortcutsOpen = false;
          event.preventDefault();
          return;
        }
        // While editing the layout, Escape belongs to the editor (cancel a
        // move, close a toolbar, then leave edit mode), not to the panels.
        if (layoutEdit?.active) return;
        if (shell.closeTopmostExpanded()) event.preventDefault();
        return;
      }

      const action = shellActionFromKeyboardEvent(
        event,
        shell.config.panels,
        shell.settings,
      );
      if (!action) return;
      if (action.type === 'show-shortcuts') {
        if (!shortcutEdges.some(hotkeyActive)) return;
        event.preventDefault();
        shortcutsOpen = true;
      } else {
        if (!hotkeyActive(action.edge)) return;
        event.preventDefault();
        shell.togglePanel(action.edge);
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      offViewport();
      offOverlayMedia();
      if (closingTimer) clearTimeout(closingTimer);
      offKeyboard();
      offFormActions();
      scrollChrome?.destroy();
      scrollChrome = null;
    };
  });

  // Pinning (a banner appears, a drawer opens, leaving phone) shows the bar.
  $effect(() => {
    if (pinChrome || phoneSurfaceOpen || !isPhone) chromeHidden = false;
  });

  // Navigating on a phone closes drawers/sheets and brings the top bar back.
  let lastPath: string | undefined;
  $effect(() => {
    const current = path;
    untrack(() => {
      if (lastPath !== undefined && current !== lastPath) {
        if (shell.viewport === 'phone') collapsePhoneSurfaces();
        scrollChrome?.reset();
        chromeHidden = false;
      }
      lastPath = current;
    });
  });

  // ---- Resizable side edges ------------------------------------------------

  function remInPx(): number {
    if (typeof window === 'undefined') return 16;
    const size = Number.parseFloat(
      window.getComputedStyle(document.documentElement).fontSize,
    );
    return Number.isFinite(size) && size > 0 ? size : 16;
  }

  function cssLengthToPx(length: string): number | null {
    const match = /^\s*(-?\d*\.?\d+)(px|rem|em)?\s*$/.exec(length);
    if (!match) return null;
    const value = Number.parseFloat(match[1]);
    return match[2] === 'rem' || match[2] === 'em' ? value * remInPx() : value;
  }

  /**
   * The edge's expanded width in px: the resized width, else the configured
   * `expandedSize` (measured when it is not a plain px/rem length).
   */
  function currentSize(edge: SideEdge): number {
    const limits = shell.resizeLimits(edge);
    const resized = shell.panelSize(edge);
    if (resized !== null) return resized;
    const width =
      cssLengthToPx(shell.config.panels[edge].expandedSize) ??
      sideElements[edge]?.getBoundingClientRect().width ??
      0;
    return limits ? clampPanelSize(width, limits) : Math.round(width);
  }

  function canResize(edge: SideEdge): boolean {
    return (
      !isPhone &&
      edgeExpanded(edge) &&
      shell.presentationFor(edge) === 'push' &&
      shell.resizeLimits(edge) !== null
    );
  }

  function onResizeKeydown(event: KeyboardEvent, edge: SideEdge): void {
    const limits = shell.resizeLimits(edge);
    if (!limits) return;
    const step = limits.step * (event.shiftKey ? 4 : 1);
    const grow = edge === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = edge === 'left' ? 'ArrowLeft' : 'ArrowRight';
    let next: number | null;
    if (event.key === grow) next = currentSize(edge) + step;
    else if (event.key === shrink) next = currentSize(edge) - step;
    else if (event.key === 'Home') next = limits.min;
    else if (event.key === 'End') next = limits.max;
    else if (event.key === 'Enter') next = null;
    else return;
    event.preventDefault();
    shell.setPanelSize(edge, next);
  }

  /** Tears down the drag in progress, if any (see onResizePointerdown). */
  let stopActiveResize: ((commit: boolean) => void) | null = null;

  // Unmounting mid-drag must not leave the handle's listeners driving a shell
  // state that outlives this component, nor a stale `resizing` flag.
  $effect(() => () => stopActiveResize?.(false));

  function onResizePointerdown(event: PointerEvent, edge: SideEdge): void {
    if (event.button !== 0 || !shell.resizeLimits(edge)) return;
    event.preventDefault();
    stopActiveResize?.(true);
    const handle = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    if (pointerId !== undefined) handle.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startSize = currentSize(edge);
    let latest = startSize;
    resizing = edge;

    function onMove(move: PointerEvent): void {
      const dx = move.clientX - startX;
      latest = startSize + (edge === 'left' ? dx : -dx);
      shell.setPanelSize(edge, latest, { persist: false });
    }

    function stop(commit: boolean): void {
      if (stopActiveResize !== stop) return;
      stopActiveResize = null;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      handle.removeEventListener('lostpointercapture', onEnd);
      if (pointerId !== undefined && handle.hasPointerCapture?.(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      resizing = null;
      if (commit && latest !== startSize) shell.setPanelSize(edge, latest);
    }

    // pointerup/pointercancel end a drag normally; losing the capture (a
    // system gesture, the element leaving the DOM) ends it too, or the shell
    // would stay in its resizing state with nothing to release it.
    function onEnd(): void {
      stop(true);
    }

    stopActiveResize = stop;
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
    handle.addEventListener('lostpointercapture', onEnd);
  }

  const footerInHeader = $derived(
    !account &&
      !!tenantFooter &&
      (!shell.isEdgeShown('left') ||
        (!edgeExpanded('left') && !tenantRailFooter)),
  );

  function regionVisible(region: ShellRegion): boolean {
    return shell.isRegionVisible(region);
  }

  /**
   * Whether a region shows its hide control in edit mode: a sidebar has one as
   * soon as its rail is rendered, even while collapsed (its slots then fall
   * back, but the region itself is still there to hide).
   */
  function regionControllable(region: ShellRegion): boolean {
    if (region === 'leftSidebar') return shell.isEdgeShown('left');
    if (region === 'rightSidebar') return shell.isEdgeShown('right');
    return regionVisible(region);
  }

  /** Slots whose content lands at `target` (own content plus fallbacks). */
  const slotContent = $derived.by(() => {
    const placed: Partial<Record<ShellSlot, Snippet[]>> = {};
    for (const [name, snippet] of Object.entries(slots ?? {}) as [
      ShellSlot,
      Snippet | undefined,
    ][]) {
      if (!snippet) continue;
      const target = resolveSlot(name, regionVisible);
      if (target) (placed[target] ??= []).push(snippet);
    }
    return placed;
  });

  const STRIP_TRACK = '1.75rem';
  const REGION_TRACK: Record<ShellRegion, string> = {
    header: 'top',
    footer: 'bottom',
    leftSidebar: 'left',
    rightSidebar: 'right',
  };
  const stripRegions = $derived(
    layoutEdit?.active && layoutEdit.strip ? (layoutEdit.hiddenRegions ?? []) : [],
  );
  const layoutStyle = $derived(
    [
      buildLayoutStyle(shell),
      ...stripRegions.map(
        (region) => `--smrt-admin-shell-${REGION_TRACK[region]}-track: ${STRIP_TRACK}`,
      ),
    ].join('; '),
  );

  // Top/bottom edges reserve grid tracks for corner snippets. When a corner
  // isn't mounted its track must collapse, otherwise the band is squeezed
  // between phantom tracks sized by the collapsed panel widths.
  function edgeColumns(left: unknown, right: unknown): string {
    const l = 'var(--smrt-admin-shell-left-collapsed)';
    const r = 'var(--smrt-admin-shell-right-collapsed)';
    return `${left ? l : '0px'} minmax(0, 1fr) ${right ? r : '0px'}`;
  }

  const topEdgeColumns = $derived(edgeColumns(topLeftCorner, topRightCorner));
  const bottomEdgeColumns = $derived(
    edgeColumns(bottomLeftCorner, bottomRightCorner),
  );

  function panelState(edge: PanelEdge) {
    return shell.panels[edge];
  }

  function edgeExpanded(edge: PanelEdge): boolean {
    return panelState(edge) === 'expanded';
  }

  /** Collapsed edge whose panel content stays mounted (`keepMounted`). */
  function keepsContent(edge: PanelEdge): boolean {
    return (
      panelState(edge) === 'collapsed' &&
      shell.config.panels[edge].keepMounted === true &&
      !((edge === 'top' || edge === 'bottom') && shell.isInline(edge))
    );
  }

  // While editing, a closed railless right edge that has focus tools gets a
  // slim indicator tab so its content stays reachable; the host's header
  // toggle covers normal use.
  const editIndicator = $derived(
    !!layoutEdit?.active &&
      !isPhone &&
      shell.config.panels.right.rail === false &&
      shell.isEdgeShown('right') &&
      panelState('right') === 'collapsed' &&
      shell.focusTools.length > 0
      ? shell.focusTools
      : null,
  );
  let openedByIndicator = false;
  function openFromIndicator(): void {
    const tools = shell.focusTools;
    if (tools.length === 0) return;
    const tool = tools.find((candidate) => candidate.id === shell.activeFocusToolId) ?? tools[0];
    shell.openFocusTool(tool.id);
    openedByIndicator = true;
  }
  $effect(() => {
    if (layoutEdit?.active) return;
    untrack(() => {
      if (openedByIndicator && shell.panels.right === 'expanded') {
        shell.collapsePanel('right');
      }
      openedByIndicator = false;
    });
  });

  function panelMounted(edge: PanelEdge): boolean {
    return shownOpen(edge) || keepsContent(edge);
  }

  function labelFor(edge: PanelEdge): string {
    return shell.config.panels[edge].label;
  }

  function hotkeyFor(edge: PanelEdge): string {
    return formatHotkeyBinding(
      resolveHotkey(edge, shell.config.panels[edge], shell.settings),
    );
  }

  function toggleOn(edge: PanelEdge): boolean {
    return typeof edgeToggles === 'boolean'
      ? edgeToggles
      : edgeToggles[edge] === true;
  }

  /** The edge draws its toggle button (phones always get one in the left drawer). */
  function showToggle(edge: PanelEdge): boolean {
    let on = toggleOn(edge);
    if (edge === 'left') {
      if (showTenantToggle === false) on = false;
      else if (showTenantToggle === true) on = true;
    }
    return on;
  }

  const dropdownEdges = $derived({
    top: showToggle('top') || toggleOn('top') || hotkeys === true,
    left: showToggle('left') || toggleOn('left') || hotkeys === true,
    right: showToggle('right') || toggleOn('right') || hotkeys === true,
    bottom: showToggle('bottom') || toggleOn('bottom') || hotkeys === true,
  });
  // Edges without a drop-down are laid out inline (see `ShellState.isInline`).
  shell.setInlineEdges(
    untrack(() => ({
      top: !dropdownEdges.top,
      left: !dropdownEdges.left,
      right: !dropdownEdges.right,
      bottom: !dropdownEdges.bottom,
    })),
  );
  $effect(() => {
    const next = dropdownEdges;
    shell.setInlineEdges({
      top: !next.top,
      left: !next.left,
      right: !next.right,
      bottom: !next.bottom,
    });
  });

  function hotkeyActive(edge: PanelEdge): boolean {
    if (hotkeys !== undefined) return hotkeys;
    return toggleOn(edge) || showToggle(edge);
  }

  function showsHotkeyFor(edge: PanelEdge): boolean {
    return (
      hotkeyActive(edge) &&
      shell.settings.hotkeysEnabled !== false &&
      resolveHotkey(edge, shell.config.panels[edge], shell.settings) !== null
    );
  }

  // Focus containment for the modal shortcuts dialog. Runs on mount of the
  // dialog node and tears down when it unmounts (Escape / close), restoring
  // focus to whatever opened it. Keeps `aria-modal="true"` honest.
  function focusTrap(node: HTMLElement) {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => el.offsetParent !== null,
      );
    (focusable()[0] ?? node).focus();

    function onKeydown(event: KeyboardEvent): void {
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    node.addEventListener('keydown', onKeydown);
    return {
      destroy(): void {
        node.removeEventListener('keydown', onKeydown);
        previouslyFocused?.focus();
      },
    };
  }
</script>

{#snippet edgeToggle(edge: PanelEdge)}
  <Button
    variant="ghost"
    size="sm"
    class="smrt-admin-shell__edge-toggle"
    aria-label={edge === 'left' ? t(M[edgeExpanded(edge) ? 'ui.admin_shell.collapse_panel' : 'ui.admin_shell.expand_panel'], { panel: labelFor(edge) }) : undefined}
    aria-expanded={edgeExpanded(edge)}
    aria-controls={`smrt-admin-shell-${edge}-panel`}
    onclick={() => shell.togglePanel(edge)}
  >
    {#if edge === 'left' && !edgeExpanded(edge)}<span aria-hidden="true">›</span>{:else}<span>{labelFor(edge)}</span>{/if}
    {#if showsHotkeyFor(edge) && (edge !== 'left' || edgeExpanded(edge))}
      <kbd class="smrt-admin-shell__edge-toggle-kbd">{hotkeyFor(edge)}</kbd>
    {/if}
    <ActivityBadge {edge} />
  </Button>
{/snippet}

{#snippet resizer(edge: SideEdge)}
  {#if canResize(edge)}
    {@const limits = shell.resizeLimits(edge)}
    <!-- A focusable separator is the WAI-ARIA window-splitter widget; Svelte's
         role table lists `separator` as non-interactive only in its static form. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="smrt-admin-shell__resizer smrt-admin-shell__resizer--{edge}"
      role="separator"
      aria-orientation="vertical"
      aria-controls={`smrt-admin-shell-${edge}-panel`}
      aria-label={t(M['ui.admin_shell.resize_panel'], { label: labelFor(edge) })}
      aria-valuemin={limits?.min}
      aria-valuemax={limits?.max}
      aria-valuenow={currentSize(edge)}
      tabindex="0"
      data-testid={`admin-shell-resizer-${edge}`}
      onpointerdown={(event) => onResizePointerdown(event, edge)}
      onkeydown={(event) => onResizeKeydown(event, edge)}
      ondblclick={() => shell.setPanelSize(edge, null)}
    ></div>
  {/if}
{/snippet}

{#snippet focusContent(tool: ShellFocusTool | null)}
  {#if focusPanel}
    {@render focusPanel({ tool })}
  {:else if tool?.render}
    {@render tool.render({ tool })}
  {:else if tool?.component}
    {@const FocusComponent = tool.component}
    <FocusComponent {tool} {shell} />
  {:else}
    <p class="smrt-admin-shell__empty">
      {t(M['ui.admin_shell.no_focus_tools'])}
    </p>
  {/if}
{/snippet}

{#snippet shellBrand(compact = false)}
  <ShellBrand {title} {subtitle} {homeHref} {logoSrc} {logoAlt} {brand} {compact} />
{/snippet}

{#snippet slotGroup(name: ShellSlot)}
  {#if layoutEdit?.active}
    {#if regionVisible(slotRegion(name))}
      <div
        class="smrt-admin-shell__slot smrt-admin-shell__slot--{name.replace('.', '-')} smrt-admin-shell__slot--editing"
        data-slot={name}
        data-smrt-edit-zone={name}
        data-drop-target={layoutEdit.highlight === name ? '' : undefined}
      >
        {@render layoutEdit.zone(name)}
      </div>
    {/if}
  {:else if slotContent[name]?.length}
    <div
      class="smrt-admin-shell__slot smrt-admin-shell__slot--{name.replace('.', '-')}"
      data-slot={name}
    >
      {#each slotContent[name] ?? [] as content}{@render content()}{/each}
    </div>
  {/if}
{/snippet}

{#snippet regionEdit(region: ShellRegion)}
  {#if layoutEdit?.active && layoutEdit.regionControl && regionControllable(region)}
    <div class="smrt-admin-shell__region-edit" data-region-edit={region}>
      {@render layoutEdit.regionControl(region)}
    </div>
  {/if}
{/snippet}

{#snippet regionStrip(region: ShellRegion)}
  {#if stripRegions.includes(region)}
    <div
      class="smrt-admin-shell__strip smrt-admin-shell__strip--{region}"
      data-region-strip={region}
    >
      {@render layoutEdit?.strip?.(region)}
    </div>
  {/if}
{/snippet}

<div
  bind:this={rootElement}
  class="smrt-admin-shell"
  data-top-state={panelState('top')}
  data-left-state={panelState('left')}
  data-right-state={panelState('right')}
  data-bottom-state={panelState('bottom')}
  data-viewport={viewport}
  data-bottom-bar={bottomBar}
  data-phone-top={showPhoneTop ? '' : undefined}
  data-chrome-hidden={chromeHidden ? '' : undefined}
  data-resizing={resizing ?? undefined}
  style={`${layoutStyle}; ${chromeStyle}; ${reserveStyle}`}
>
  {#if showHeader}
    <div
      id="smrt-admin-shell-header"
      class="smrt-admin-shell__header"
      data-testid="admin-shell-header"
    >
      {@render header?.({ viewport })}
    </div>
  {/if}

  {@render regionStrip('header')}
  {#if panelState('top') !== 'hidden'}
    <header
      id="smrt-admin-shell-top-panel"
      class="smrt-admin-shell__edge smrt-admin-shell__edge--top"
      data-state={panelState('top')}
      data-presentation={shell.config.panels.top.presentation}
      style:--edge-columns={topEdgeColumns}
    >
      {#if topLeftCorner}
        <div class="smrt-admin-shell__corner smrt-admin-shell__corner--top-left">
          {@render topLeftCorner()}
        </div>
      {/if}
      <div
        class="smrt-admin-shell__band smrt-admin-shell__band--top"
        style:--band-column={2}
      >
        {#if appBar}
          {@render appBar()}
        {:else}
          {#if !brandInSlot}{@render shellBrand()}{/if}
          {#if showToggle('top')}{@render edgeToggle('top')}{/if}
        {/if}
        {#if !(layoutEdit?.active && !isPhone) && shell.config.panels.left.initial !== 'hidden' && shell.layoutPanels.left?.visible !== false && (!isPhone || shell.phonePresentation('left') !== 'hidden')}
          <div class="smrt-admin-shell__tenant-opener" class:restore-hidden={panelState('left') === 'hidden'}>
            <Button variant="ghost" size="sm" aria-label={t(M['ui.admin_shell.menu'])} aria-expanded={edgeExpanded('left')} aria-controls="smrt-admin-shell-left-panel" onclick={() => shell.setPanelState('left', edgeExpanded('left') ? 'collapsed' : 'expanded')}>{t(M['ui.admin_shell.menu'])}</Button>
          </div>
        {/if}
        {@render slotGroup('header.start')}
        {@render slotGroup('header.center')}
        {#if account || footerInHeader}
          <div class="smrt-admin-shell__account">
            {#if account}{@render account()}{:else if tenantFooter}{@render tenantFooter()}{/if}
          </div>
        {/if}
        {@render slotGroup('header.end')}
        {@render regionEdit('header')}
      </div>
      {#if topRightCorner}
        <div class="smrt-admin-shell__corner smrt-admin-shell__corner--top-right">
          {@render topRightCorner()}
        </div>
      {/if}
      {#if panelMounted('top')}
        <section
          class="smrt-admin-shell__drawer smrt-admin-shell__drawer--top"
          aria-label={labelFor('top')}
          hidden={!edgeExpanded('top')}
        >
          {#if appPanel}
            {@render appPanel()}
          {:else}
            <p class="smrt-admin-shell__empty">
              {t(M['ui.admin_shell.no_app_panel'])}
            </p>
          {/if}
        </section>
      {/if}
    </header>
  {/if}

  {@render regionStrip('leftSidebar')}
  {#if shell.isEdgeShown('left')}
    <!-- tabindex -1 only while overlaid, so the panel can take focus on open -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <aside
      id="smrt-admin-shell-left-panel"
      class="smrt-admin-shell__edge smrt-admin-shell__edge--left"
      data-state={closingEdge === 'left' ? 'expanded' : panelState('left')}
      data-closing={closingEdge === 'left' ? '' : undefined}
      data-presentation={shell.presentationFor('left')}
      aria-label={labelFor('left')}
      tabindex={overlayEdge === 'left' ? -1 : undefined}
      inert={(isPhone && !edgeExpanded('left')) ||
        overlayEdge === 'right' ||
        closingEdge === 'left'}
      onanimationend={(event) => onEdgeAnimationEnd(event, 'left')}
      bind:this={sideElements.left}
      use:swipeDismiss={{
        direction: 'left',
        onDismiss: () => shell.collapsePanel('left'),
        enabled: isPhone && Boolean(phone?.swipeToClose) && edgeExpanded('left'),
      }}
    >
      {@render resizer('left')}
      <div class="smrt-admin-shell__rail">
        {@render regionEdit('leftSidebar')}
        {#if (panelState('top') === 'hidden' || !edgeExpanded('left')) && (homeHref || logoSrc || brand)}{@render shellBrand(!edgeExpanded('left'))}{/if}
        {#if showToggle('left') || isPhone}{@render edgeToggle('left')}{/if}
        {#if shownOpen('left') || (tenantPanel && keepsContent('left'))}
          <div
            class="smrt-admin-shell__tenant-stack"
            hidden={!shownOpen('left')}
          >
            {@render slotGroup('leftSidebar.header')}
            <div class="smrt-admin-shell__tenant-content">
              {#if tenantPanel}
                {@render tenantPanel()}
              {:else if tenantRail}
                {@render tenantRail()}
              {/if}
            </div>
            {#if tenantFooter && !footerInHeader}
              <div class="smrt-admin-shell__tenant-footer">
                {@render tenantFooter()}
              </div>
            {/if}
            {@render slotGroup('leftSidebar.footer')}
          </div>
        {/if}
        {#if !shownOpen('left') && (tenantRail || tenantRailFooter)}
          <div class="smrt-admin-shell__tenant-rail-stack">
            {#if tenantRail}
              <div class="smrt-admin-shell__tenant-rail-content">
                {@render tenantRail()}
              </div>
            {/if}
            {#if tenantRailFooter}
              <div class="smrt-admin-shell__tenant-rail-footer">
                {@render tenantRailFooter()}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </aside>
  {/if}

  <main
    id="smrt-admin-shell-main"
    class="smrt-admin-shell__main"
    bind:this={mainElement}
    inert={overlayEdge !== null}
  >
    {@render children()}
  </main>

  {#if showPhoneTop}
    <div class="smrt-admin-shell__phone-top" data-testid="admin-shell-phone-top">
      {#if phoneTopBar}
        {@render phoneTopBar({ hidden: chromeHidden })}
      {:else if showDefaultPhoneTenantOpener}
        <div class="smrt-admin-shell__phone-default-top">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t(M['ui.admin_shell.menu'])}
            aria-expanded={edgeExpanded('left')}
            aria-controls="smrt-admin-shell-left-panel"
            onclick={() =>
              shell.setPanelState(
                'left',
                edgeExpanded('left') ? 'collapsed' : 'expanded',
              )}
          >{t(M['ui.admin_shell.menu'])}</Button>
        </div>
      {/if}
    </div>
  {/if}

  {#if isPhone && phone?.scrim && phoneSurfaceOpen}
    <!-- raw-primitive-allow: click-catching backdrop behind a phone drawer -->
    <button
      type="button"
      class="smrt-admin-shell__scrim"
      tabindex="-1"
      aria-label={t(M['ui.admin_shell.close_panel'], {
        label: labelFor(edgeExpanded('left') && shell.isEdgeShown('left') ? 'left' : 'right'),
      })}
      data-testid="admin-shell-scrim"
      onclick={collapsePhoneSurfaces}
    ></button>
  {/if}

  {#if overlayEdge || closingEdge}
    {@const scrimEdge = (overlayEdge ?? closingEdge) as SideEdge}
    <!-- raw-primitive-allow: click-catching backdrop behind an overlaid side panel -->
    <button
      type="button"
      class="smrt-admin-shell__overlay-scrim"
      tabindex="-1"
      aria-label={t(M['ui.admin_shell.close_panel'], { label: labelFor(scrimEdge) })}
      data-testid="admin-shell-overlay-scrim"
      data-closing={overlayEdge ? undefined : ''}
      onclick={() => {
        if (overlayEdge) shell.collapsePanel(scrimEdge);
      }}
    ></button>
  {/if}

  {@render regionStrip('rightSidebar')}
  {#if shell.isEdgeShown('right')}
    {@const rightPhone = isPhone ? shell.phonePresentation('right') : undefined}
    <!-- tabindex -1 only while overlaid, so the panel can take focus on open -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <aside
      id="smrt-admin-shell-right-panel"
      class="smrt-admin-shell__edge smrt-admin-shell__edge--right"
      data-state={closingEdge === 'right' ? 'expanded' : panelState('right')}
      data-closing={closingEdge === 'right' ? '' : undefined}
      data-presentation={shell.presentationFor('right')}
      data-phone={rightPhone}
      aria-label={labelFor('right')}
      tabindex={overlayEdge === 'right' ? -1 : undefined}
      inert={(isPhone && !edgeExpanded('right')) ||
        overlayEdge === 'left' ||
        closingEdge === 'right'}
      onanimationend={(event) => onEdgeAnimationEnd(event, 'right')}
      bind:this={sideElements.right}
      use:swipeDismiss={{
        direction: 'right',
        onDismiss: () => shell.collapsePanel('right'),
        enabled:
          rightPhone === 'drawer' &&
          Boolean(phone?.swipeToClose) &&
          edgeExpanded('right'),
      }}
    >
      {@render resizer('right')}
      {#if rightPhone === 'sheet'}
        <div
          class="smrt-admin-shell__sheet-grabber"
          aria-hidden="true"
          use:swipeDismiss={{
            direction: 'down',
            onDismiss: () => shell.collapsePanel('right'),
            enabled: edgeExpanded('right'),
          }}
        >
          <span></span>
        </div>
      {/if}
      <div class="smrt-admin-shell__rail">
        {@render regionEdit('rightSidebar')}
        {#if shell.config.panels.right.rail === false}
          <!-- Railless: no tool buttons; the host's toggle opens and closes it. -->
        {:else if focusRail}
          {@render focusRail()}
        {:else if shell.focusTools.length > 0}
          <nav class="smrt-admin-shell__focus-rail" aria-label={t(M['ui.admin_shell.focus_tools'])}>
            {#each shell.focusTools as tool (tool.id)}
              <!-- raw-primitive-allow: shell chrome toggle, not a content button -->
              <button
                type="button"
                class="smrt-admin-shell__focus-tool"
                class:active={shell.activeFocusToolId ===
                  tool.id && edgeExpanded('right')}
                aria-pressed={shell.activeFocusToolId ===
                  tool.id && edgeExpanded('right')}
                aria-label={tool.label}
                title={tool.label}
                onclick={() => shell.toggleFocusTool(tool.id)}
              >
                {#if tool.icon}
                  <tool.icon />
                {:else}
                  <span aria-hidden="true">{tool.label.charAt(0)}</span>
                {/if}
                {#if tool.badge != null}
                  <span class="smrt-admin-shell__focus-tool-badge">
                    {tool.badge}
                  </span>
                {/if}
              </button>
            {/each}
          </nav>
        {:else if showToggle('right')}
          {@render edgeToggle('right')}
        {/if}
      </div>
      {#if panelMounted('right')}
        <div
          class="smrt-admin-shell__panel smrt-admin-shell__panel--right"
          tabindex="-1"
          hidden={!shownOpen('right')}
        >
          {@render slotGroup('rightSidebar.header')}
          {#key shell.activeFocusToolId}
            {@render focusContent(resolveActiveFocusTool())}
          {/key}
          {@render slotGroup('rightSidebar.footer')}
        </div>
      {/if}
    </aside>
  {/if}

  {#if editIndicator}
    <!-- raw-primitive-allow: shell chrome toggle, not a content button -->
    <button
      type="button"
      class="smrt-admin-shell__edit-indicator"
      data-edit-indicator="right"
      aria-expanded="false"
      aria-controls="smrt-admin-shell-right-panel"
      aria-label={t(M['ui.admin_shell.open_panel'], {
        label: editIndicator.map((tool) => tool.label).join(', '),
      })}
      onclick={openFromIndicator}
    >
      {#if editIndicator[0].icon}
        {@const Icon = editIndicator[0].icon}
        <Icon />
      {/if}
      <span class="smrt-admin-shell__edit-indicator-label">
        {editIndicator.map((tool) => tool.label).join(', ')}
      </span>
    </button>
  {/if}

  {@render regionStrip('footer')}
  {#if panelState('bottom') !== 'hidden'}
    <footer
      id="smrt-admin-shell-bottom-panel"
      class="smrt-admin-shell__edge smrt-admin-shell__edge--bottom"
      data-state={panelState('bottom')}
      data-presentation={shell.config.panels.bottom.presentation}
      style:--edge-columns={bottomEdgeColumns}
    >
      {#if bottomLeftCorner}
        <div class="smrt-admin-shell__corner smrt-admin-shell__corner--bottom-left">
          {@render bottomLeftCorner()}
        </div>
      {/if}
      <div
        class="smrt-admin-shell__band smrt-admin-shell__band--bottom"
        style:--band-column={2}
      >
        {@render slotGroup('footer.start')}
        {@render slotGroup('footer.center')}
        {#if systemBar}{@render systemBar()}{/if}
        {@render slotGroup('footer.end')}
        {@render regionEdit('footer')}
        {#if showToggle('bottom') && (systemPanel || !systemBar)}{@render edgeToggle('bottom')}{/if}
      </div>
      {#if bottomRightCorner}
        <div class="smrt-admin-shell__corner smrt-admin-shell__corner--bottom-right">
          {@render bottomRightCorner()}
        </div>
      {/if}
      {#if panelMounted('bottom')}
        <section
          class="smrt-admin-shell__drawer smrt-admin-shell__drawer--bottom"
          aria-label={labelFor('bottom')}
          hidden={!edgeExpanded('bottom')}
        >
          {#if systemPanel}
            {@render systemPanel()}
          {:else}
            <p class="smrt-admin-shell__empty">
              {t(M['ui.admin_shell.no_system_panel'])}
            </p>
          {/if}
        </section>
      {/if}
    </footer>
  {/if}

  {#if overlays}
    <div class="smrt-admin-shell__overlays">
      {@render overlays({ viewport, bottomBar })}
    </div>
  {/if}

  {#if bottomBar === 'nav'}
    <div class="smrt-admin-shell__phone-bar" data-testid="admin-shell-phone-bar">
      {@render phoneBottomBar?.()}
    </div>
  {/if}

  {#if shortcutsOpen}
    <div
      class="smrt-admin-shell__shortcuts"
      role="dialog"
      aria-modal="true"
      aria-label={t(M['ui.admin_shell.shell_shortcuts'])}
      tabindex="-1"
      use:focusTrap
    >
      <div class="smrt-admin-shell__shortcuts-panel">
        {#if shortcutsOverlay}
          {@render shortcutsOverlay()}
        {:else}
          <header>
            <h2>{t(M['ui.admin_shell.shell_shortcuts'])}</h2>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t(M['ui.admin_shell.close_shortcuts'])}
              onclick={() => (shortcutsOpen = false)}
            >
              {t(M['ui.admin_shell.close'])}
            </Button>
          </header>
          <dl>
            {#each shortcutEdges as edge}
              <div>
                <dt>{labelFor(edge)}</dt>
                <dd>{hotkeyFor(edge)}</dd>
              </div>
            {/each}
            <div>
              <dt>{t(M['ui.admin_shell.shortcuts'])}</dt>
              <dd>?</dd>
            </div>
          </dl>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .smrt-admin-shell {
    --smrt-shell-floating-reserve-inline: 0px;
    --smrt-shell-floating-reserve-block: 0px;
    --smrt-shell-floating-reserve-main: 0px;
    --smrt-admin-shell-left-track: 0rem;
    --smrt-admin-shell-right-track: 0rem;
    --smrt-admin-shell-top-track: 0rem;
    --smrt-admin-shell-bottom-track: 0rem;
    --smrt-admin-shell-left-collapsed: 4.25rem;
    --smrt-admin-shell-right-collapsed: 4.25rem;
    --smrt-admin-shell-left-expanded: 16rem;
    --smrt-admin-shell-right-expanded: 20rem;
    --smrt-admin-shell-header-size: 3.5rem;
    --smrt-admin-shell-header-track: 0rem;
    --smrt-admin-shell-phone-top-size: 3.5rem;
    --smrt-admin-shell-phone-bar-size: calc(3.5rem + env(safe-area-inset-bottom));
    --smrt-admin-shell-phone-bar-track: 0rem;
    --smrt-admin-shell-chrome-duration: var(--smrt-duration-short4, 200ms);
    position: relative;
    display: grid;
    grid-template-columns:
      var(--smrt-admin-shell-left-track) minmax(0, 1fr)
      var(--smrt-admin-shell-right-track);
    /* header · top edge · body · bottom edge · phone bottom bar. The extra
       rows are 0 unless the header / phone bar render. */
    grid-template-rows:
      var(--smrt-admin-shell-header-track)
      var(--smrt-admin-shell-top-track) minmax(0, 1fr)
      var(--smrt-admin-shell-bottom-track)
      var(--smrt-admin-shell-phone-bar-track);
    min-block-size: 100svh;
    block-size: 100svh;
    /* Themeable: an app sets --smrt-admin-shell-background on the shell or an
       ancestor (a tinted page behind cards, for instance). */
    background: var(--smrt-admin-shell-background, var(--smrt-color-surface));
    color: var(--smrt-color-on-surface);
    /* `clip`, not `hidden`: a hidden box is still programmatically scrollable
       (focus / scrollIntoView on a grid-track child shifts the whole shell
       and its sidebars); a clipped box can never scroll. Only main and the
       sidebars scroll. */
    overflow: hidden;
    overflow: clip;
    /* Themed, thin scrollbars for every scroller inside the shell. Override
       --smrt-admin-shell-scrollbar-track / -thumb / -thumb-hover to retint. */
    scrollbar-color: var(--smrt-admin-shell-scrollbar-thumb, color-mix(in srgb, var(--smrt-color-on-surface) 26%, transparent))
      var(--smrt-admin-shell-scrollbar-track, color-mix(in srgb, var(--smrt-color-surface-container-low) 88%, transparent));
  }

  .smrt-admin-shell :global(*) {
    scrollbar-width: thin;
  }

  .smrt-admin-shell :global(*)::-webkit-scrollbar {
    width: 0.7rem;
    height: 0.7rem;
  }

  .smrt-admin-shell :global(*)::-webkit-scrollbar-track {
    background: var(--smrt-admin-shell-scrollbar-track, color-mix(in srgb, var(--smrt-color-surface-container-low) 88%, transparent));
  }

  .smrt-admin-shell :global(*)::-webkit-scrollbar-thumb {
    background-color: var(--smrt-admin-shell-scrollbar-thumb, color-mix(in srgb, var(--smrt-color-on-surface) 26%, transparent));
    background-clip: padding-box;
    border: 2px solid transparent;
    border-radius: var(--smrt-radius-full, 999px);
  }

  .smrt-admin-shell :global(*)::-webkit-scrollbar-thumb:hover {
    background-color: var(--smrt-admin-shell-scrollbar-thumb-hover, color-mix(in srgb, var(--smrt-color-on-surface) 38%, transparent));
  }

  .smrt-admin-shell :global(*)::-webkit-scrollbar-corner {
    background: transparent;
  }

  .smrt-admin-shell__edge {
    min-width: 0;
    min-height: 0;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    border-color: var(--smrt-color-outline-variant);
  }

  .smrt-admin-shell__header {
    grid-column: 1 / -1;
    grid-row: 1;
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    box-sizing: border-box;
    min-inline-size: 0;
    min-block-size: 0;
    padding: 0 calc(var(--smrt-spacing-3) + var(--smrt-shell-floating-reserve-inline)) 0 var(--smrt-spacing-2);
    /* Clip long titles sideways only: menus and popovers opened from the
       header's actions (a notifications bell, an account menu) must be able
       to drop below it. `clip` (unlike `hidden`) allows a visible block axis. */
    overflow-x: clip;
    overflow-y: visible;
    border-block-end: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    z-index: 30;
  }

  .smrt-admin-shell__edge--top {
    grid-column: 1 / -1;
    grid-row: 2;
    display: grid;
    grid-template-columns: var(
      --edge-columns,
      var(--smrt-admin-shell-left-collapsed) minmax(0, 1fr)
        var(--smrt-admin-shell-right-collapsed)
    );
    border-block-end: 1px solid var(--smrt-color-outline-variant);
    z-index: 30;
  }

  .smrt-admin-shell__edge--left {
    position: relative;
    grid-column: 1;
    grid-row: 3;
    border-inline-end: 1px solid var(--smrt-color-outline-variant);
    z-index: 20;
  }

  .smrt-admin-shell__edge--right {
    position: relative;
    grid-column: 3;
    grid-row: 3;
    border-inline-start: 1px solid var(--smrt-color-outline-variant);
    z-index: 20;
  }

  .smrt-admin-shell__edge--right[data-state='expanded'] {
    display: grid;
    grid-template-columns:
      minmax(0, 1fr)
      min(var(--smrt-admin-shell-right-collapsed), 100%);
  }

  .smrt-admin-shell__edge--bottom {
    grid-column: 1 / -1;
    grid-row: 4;
    display: grid;
    grid-template-columns: var(
      --edge-columns,
      var(--smrt-admin-shell-left-collapsed) minmax(0, 1fr)
        var(--smrt-admin-shell-right-collapsed)
    );
    border-block-start: 1px solid var(--smrt-color-outline-variant);
    z-index: 30;
  }

  .smrt-admin-shell__main {
    grid-column: 2;
    grid-row: 3;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding-block-start: var(--smrt-shell-floating-reserve-main);
    background: var(--smrt-color-surface);
  }

  .smrt-admin-shell__band {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
    min-width: 0;
    min-block-size: 0;
    padding: 0 var(--smrt-spacing-4);
  }

  .smrt-admin-shell__band--top,
  .smrt-admin-shell__band--bottom {
    grid-column: var(--band-column, 2);
  }

  /* The header's slots can render in the top band too: keep the floating
     layout toggle's corner clear there as well. */
  .smrt-admin-shell__band--top {
    padding-inline-end: calc(var(--smrt-spacing-4) + var(--smrt-shell-floating-reserve-inline));
  }

  .smrt-admin-shell__empty {
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-admin-shell__rail {
    box-sizing: border-box;
    min-width: 0;
    min-height: 0;
    block-size: 100%;
    overflow: auto;
    padding: var(--smrt-spacing-3);
  }

  /* A right rail never pads wider than its own track: a rail collapsed to 0
     (an app that shows nothing there) paints no padding. */
  .smrt-admin-shell__edge--right .smrt-admin-shell__rail {
    padding-inline: min(
      var(--smrt-spacing-3),
      calc(var(--smrt-admin-shell-right-collapsed) / 4)
    );
  }

  .smrt-admin-shell__focus-rail {
    display: grid;
    /* Center tracks, not just items: buttons may be wider than the
       collapsed strip's content box (see ToolsDock). */
    justify-content: center;
    justify-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .smrt-admin-shell__focus-tool {
    position: relative;
    display: grid;
    place-items: center;
    width: 2.35rem;
    height: 2.35rem;
    border: 1px solid transparent;
    border-radius: var(--smrt-radius-md, 8px);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
    font: inherit;
  }

  .smrt-admin-shell__focus-tool:hover,
  .smrt-admin-shell__focus-tool.active {
    color: var(--smrt-color-primary);
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-surface-container-high);
  }

  /* Edit-mode tab for a closed railless right edge: pinned to the shell's
     right edge, vertically centred, over the page without taking space. */
  .smrt-admin-shell__edit-indicator {
    grid-column: 1 / -1;
    grid-row: 3;
    justify-self: end;
    align-self: center;
    z-index: 21;
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-2, 0.5rem);
    border: 1px solid var(--smrt-color-outline-variant);
    border-inline-end: 0;
    border-start-start-radius: var(--smrt-radius-md, 8px);
    border-end-start-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
    font: inherit;
    font-size: var(--smrt-typography-label-small-size, 0.75rem);
    cursor: pointer;
  }

  .smrt-admin-shell__edit-indicator:hover {
    color: var(--smrt-color-primary);
    border-color: var(--smrt-color-primary);
  }

  .smrt-admin-shell__edit-indicator :global(svg) {
    inline-size: 1rem;
    block-size: 1rem;
  }

  .smrt-admin-shell__focus-tool-badge {
    position: absolute;
    inset-block-start: -0.25rem;
    inset-inline-end: -0.25rem;
    min-width: 1rem;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    line-height: 1rem;
    text-align: center;
  }

  .smrt-admin-shell__edge--left[data-state='expanded']
    .smrt-admin-shell__rail {
    overflow: hidden;
  }

  .smrt-admin-shell__account {
    min-inline-size: 0;
    max-inline-size: min(20rem, 45vw);
    flex: 1 1 12rem;
  }
  .smrt-admin-shell__account :global(.smrt-workspace-account-menu .dropdown__menu) {
    top: 100%; bottom: auto; right: 0; left: auto;
    inline-size: max-content;
    max-inline-size: calc(100vw - 2 * var(--smrt-spacing-4));
  }

  .smrt-admin-shell__tenant-opener { display: none; flex-shrink: 0; }
  .smrt-admin-shell__tenant-opener.restore-hidden { display: block; }
  .smrt-admin-shell__edge--left[data-state='collapsed'] .smrt-admin-shell__rail { padding-inline: var(--smrt-spacing-2); }

  .smrt-admin-shell__edge--left .smrt-admin-shell__rail {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
    overflow: visible;
  }

  /* A collapsed `keepMounted` edge keeps its panel in the DOM but hidden;
     the panel classes set `display`, which would otherwise win over the
     `hidden` attribute. */
  .smrt-admin-shell__tenant-stack[hidden],
  .smrt-admin-shell__panel[hidden],
  .smrt-admin-shell__drawer[hidden] {
    display: none !important;
  }

  .smrt-admin-shell__tenant-stack {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3);
    min-width: 0;
    min-height: 0;
  }

  /* Only the navigation/content area grows; the sidebar header and footer
     slots (and the legacy tenant footer) keep their natural height. */
  .smrt-admin-shell__tenant-content {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .smrt-admin-shell__region-edit {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: flex-end;
  }

  .smrt-admin-shell__edge--top .smrt-admin-shell__region-edit,
  .smrt-admin-shell__edge--bottom .smrt-admin-shell__region-edit {
    margin-inline-start: auto;
  }

  .smrt-admin-shell__slot {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
    min-width: 0;
  }

  .smrt-admin-shell__slot--header-center,
  .smrt-admin-shell__slot--footer-center {
    flex: 1 1 auto;
    justify-content: center;
  }

  .smrt-admin-shell__slot--header-end,
  .smrt-admin-shell__slot--footer-end {
    margin-inline-start: auto;
  }

  .smrt-admin-shell__slot--leftSidebar-header,
  .smrt-admin-shell__slot--rightSidebar-header {
    padding-block-end: var(--smrt-spacing-3);
    border-block-end: 1px solid var(--smrt-color-outline-variant);
  }

  .smrt-admin-shell__slot--leftSidebar-footer,
  .smrt-admin-shell__slot--rightSidebar-footer {
    padding-block-start: var(--smrt-spacing-3);
    border-block-start: 1px solid var(--smrt-color-outline-variant);
  }

  .smrt-admin-shell__slot--rightSidebar-header {
    position: sticky;
    inset-block-start: 0;
    background: var(--smrt-color-surface);
  }

  .smrt-admin-shell__slot--rightSidebar-footer {
    position: sticky;
    inset-block-end: 0;
    background: var(--smrt-color-surface);
  }

  /* Layout editing: slots as dashed drop zones, hidden regions as strips. */
  .smrt-admin-shell__slot--editing {
    flex-wrap: wrap;
    box-sizing: border-box;
    min-inline-size: 4rem;
    min-block-size: 2.25rem;
    padding: var(--smrt-spacing-1);
    border: 1px dashed var(--smrt-color-outline);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    background: color-mix(in srgb, var(--smrt-color-primary) 4%, transparent);
  }
  .smrt-admin-shell__slot--editing[data-drop-target] {
    border-style: solid;
    border-color: var(--smrt-color-primary);
    background: color-mix(in srgb, var(--smrt-color-primary) 14%, transparent);
  }
  .smrt-admin-shell__slot--editing.smrt-admin-shell__slot--header-center,
  .smrt-admin-shell__slot--editing.smrt-admin-shell__slot--footer-center {
    justify-content: flex-start;
  }
  .smrt-admin-shell__strip {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2);
    box-sizing: border-box;
    min-inline-size: 0;
    min-block-size: 0;
    overflow: hidden;
    border: 1px dashed var(--smrt-color-outline);
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-label-small-font);
    z-index: 25;
  }
  .smrt-admin-shell__strip--header { grid-column: 1 / -1; grid-row: 2; }
  .smrt-admin-shell__strip--footer { grid-column: 1 / -1; grid-row: 4; }
  .smrt-admin-shell__strip--leftSidebar { grid-column: 1; grid-row: 3; writing-mode: vertical-rl; flex-direction: row; }
  .smrt-admin-shell__strip--rightSidebar { grid-column: 3; grid-row: 3; writing-mode: vertical-rl; flex-direction: row; }
  .smrt-admin-shell[data-viewport='phone'] .smrt-admin-shell__strip--leftSidebar,
  .smrt-admin-shell[data-viewport='phone'] .smrt-admin-shell__strip--rightSidebar { display: none; }

  .smrt-admin-shell__tenant-footer {
    min-width: 0;
    padding-block-start: var(--smrt-spacing-3);
    border-block-start: 1px solid var(--smrt-color-outline-variant);
  }

  .smrt-admin-shell__tenant-rail-stack {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  .smrt-admin-shell__tenant-rail-content {
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .smrt-admin-shell__tenant-rail-footer {
    position: relative;
    z-index: 1;
    grid-row: 2;
    min-width: 0;
    padding-block-start: var(--smrt-spacing-2);
    border-block-start: 1px solid var(--smrt-color-outline-variant);
    overflow: visible;
  }

  .smrt-admin-shell__edge--right[data-state='expanded']
    .smrt-admin-shell__rail {
    grid-column: 2;
    border-inline-start: 1px solid var(--smrt-color-outline-variant);
  }

  .smrt-admin-shell__panel {
    box-sizing: border-box;
    min-width: 0;
    min-height: 0;
    block-size: 100%;
    overflow: auto;
    padding: var(--smrt-spacing-3);
  }

  .smrt-admin-shell__panel--right {
    grid-column: 1;
    grid-row: 1;
    padding-block-start: var(--smrt-shell-floating-reserve-block);
  }

  .smrt-admin-shell__edge-toggle-kbd {
    padding: 0 var(--smrt-spacing-1);
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size);
  }

  .smrt-admin-shell__drawer {
    position: absolute;
    z-index: 40;
    overflow: auto;
    padding: var(--smrt-spacing-5);
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    box-shadow: var(--smrt-elevation-3);
  }

  .smrt-admin-shell__drawer--top {
    inset-block-start: calc(
      var(--smrt-admin-shell-header-track) + var(--smrt-admin-shell-top-track)
    );
    inset-inline: var(--smrt-admin-shell-left-track)
      var(--smrt-admin-shell-right-track);
    max-block-size: var(--smrt-admin-shell-top-expanded);
  }

  .smrt-admin-shell__drawer--bottom {
    inset-block-end: calc(
      var(--smrt-admin-shell-bottom-track) +
        var(--smrt-admin-shell-phone-bar-track)
    );
    /* The system scope is the application footer. Its expanded drawer must
       remain footer-wide while it rises above every desktop pane. */
    inset-inline: 0;
    max-block-size: var(--smrt-admin-shell-bottom-expanded);
    animation: smrt-admin-shell-bottom-drawer-in var(--smrt-duration-short2)
      var(--smrt-easing-standard);
  }

  @keyframes smrt-admin-shell-bottom-drawer-in {
    from {
      clip-path: inset(100% 0 0);
    }
  }

  .smrt-admin-shell__corner {
    display: grid;
    align-items: center;
    min-width: 0;
    padding: 0 var(--smrt-spacing-3);
    background: var(--smrt-color-surface-container-low);
  }

  .smrt-admin-shell__corner--top-left,
  .smrt-admin-shell__corner--bottom-left {
    grid-column: 1;
  }

  .smrt-admin-shell__corner--top-right,
  .smrt-admin-shell__corner--bottom-right {
    grid-column: 3;
  }

  .smrt-admin-shell__shortcuts {
    position: fixed;
    inset: 0;
    z-index: var(--smrt-z-index-dialog, 1300);
    display: grid;
    place-items: center;
    padding: var(--smrt-spacing-5);
    background: var(--smrt-color-scrim);
  }

  .smrt-admin-shell__shortcuts-panel {
    inline-size: min(32rem, 100%);
    max-block-size: min(36rem, 100%);
    overflow: auto;
    border-radius: var(--smrt-radius-large);
    background: var(--smrt-color-surface-container);
    padding: var(--smrt-spacing-5);
    box-shadow: var(--smrt-elevation-4);
  }

  .smrt-admin-shell__shortcuts-panel header,
  .smrt-admin-shell__shortcuts-panel div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-4);
  }

  .smrt-admin-shell__shortcuts-panel h2,
  .smrt-admin-shell__shortcuts-panel dl {
    margin: 0;
  }

  .smrt-admin-shell__shortcuts-panel dl {
    display: grid;
    gap: var(--smrt-spacing-3);
    margin-block-start: var(--smrt-spacing-4);
  }

  .smrt-admin-shell__shortcuts-panel dd {
    margin: 0;
    font-family: var(--smrt-font-family-mono);
  }

  /* ---- Resizable side edges ------------------------------------------ */

  .smrt-admin-shell__resizer {
    position: absolute;
    inset-block: 0;
    z-index: 2;
    inline-size: 0.75rem;
    cursor: col-resize;
    touch-action: none;
  }

  .smrt-admin-shell__resizer--left {
    inset-inline-end: -0.375rem;
  }

  .smrt-admin-shell__resizer--right {
    inset-inline-start: -0.375rem;
  }

  .smrt-admin-shell__resizer::after {
    content: '';
    position: absolute;
    inset-block: 0;
    inset-inline-start: calc(50% - 1px);
    inline-size: 2px;
    background: var(--smrt-color-primary);
    opacity: 0;
    transition: opacity var(--smrt-duration-short2, 100ms)
      var(--smrt-easing-standard, ease);
  }

  .smrt-admin-shell__resizer:hover::after,
  .smrt-admin-shell__resizer:focus-visible::after,
  .smrt-admin-shell[data-resizing] .smrt-admin-shell__resizer::after {
    opacity: 1;
  }

  .smrt-admin-shell__resizer:focus-visible {
    outline: none;
  }

  .smrt-admin-shell[data-resizing] {
    cursor: col-resize;
    user-select: none;
  }

  /* ---- Phone chrome ----------------------------------------------------- */

  .smrt-admin-shell__phone-top {
    grid-column: 1 / -1;
    grid-row: 3;
    align-self: start;
    z-index: 10;
    min-inline-size: 0;
    background: var(--smrt-color-surface);
    transition: transform var(--smrt-admin-shell-chrome-duration)
      var(--smrt-easing-standard, ease);
  }

  .smrt-admin-shell__phone-default-top {
    display: flex;
    align-items: center;
    min-block-size: var(--smrt-admin-shell-phone-top-size);
    padding-inline: var(--smrt-spacing-3);
  }

  .smrt-admin-shell[data-chrome-hidden] .smrt-admin-shell__phone-top {
    transform: translateY(-100%);
  }

  .smrt-admin-shell[data-phone-top] .smrt-admin-shell__main {
    padding-block-start: var(--smrt-admin-shell-phone-top-size);
    scroll-padding-block-start: var(--smrt-admin-shell-phone-top-size);
  }

  .smrt-admin-shell__phone-bar {
    grid-column: 1 / -1;
    grid-row: 5;
    z-index: 30;
    min-inline-size: 0;
  }

  .smrt-admin-shell__overlays {
    position: relative;
    grid-column: 1 / -1;
    grid-row: 1 / 5;
    z-index: 35;
    min-inline-size: 0;
    min-block-size: 0;
    pointer-events: none;
  }

  .smrt-admin-shell__overlays > :global(*) {
    pointer-events: auto;
  }

  .smrt-admin-shell__scrim {
    grid-column: 1 / -1;
    grid-row: 1 / 5;
    z-index: 19;
    margin: 0;
    padding: 0;
    border: 0;
    background: var(--smrt-color-scrim);
    opacity: 0.36;
    cursor: pointer;
  }

  /* Tablet/desktop overlay: an expanded side edge whose `overlayMedia`
     matches slides over the page instead of taking a grid track. */
  .smrt-admin-shell__edge--left[data-presentation='overlay'][data-state='expanded'],
  .smrt-admin-shell__edge--right[data-presentation='overlay'][data-state='expanded'] {
    grid-column: 1 / -1;
    z-index: 25;
    box-shadow: var(
      --smrt-elevation-3,
      0 0.5rem 1.5rem color-mix(in srgb, var(--smrt-color-shadow, #000) 24%, transparent)
    );
    outline: none;
  }

  .smrt-admin-shell__edge--left[data-presentation='overlay'][data-state='expanded'] {
    justify-self: start;
    inline-size: min(var(--smrt-admin-shell-left-expanded), 100%);
    animation: smrt-admin-shell-slide-from-left
      var(--smrt-admin-shell-chrome-duration) ease-out;
  }

  .smrt-admin-shell__edge--right[data-presentation='overlay'][data-state='expanded'] {
    justify-self: end;
    inline-size: min(var(--smrt-admin-shell-right-expanded), 100%);
    animation: smrt-admin-shell-slide-from-right
      var(--smrt-admin-shell-chrome-duration) ease-out;
  }

  .smrt-admin-shell__overlay-scrim {
    grid-column: 1 / -1;
    grid-row: 3;
    z-index: 22;
    margin: 0;
    padding: 0;
    border: 0;
    background: var(--smrt-color-scrim);
    opacity: 0.24;
    cursor: pointer;
    animation: smrt-admin-shell-scrim-in var(--smrt-admin-shell-chrome-duration)
      ease-out;
  }

  .smrt-admin-shell__edge--left[data-presentation='overlay'][data-closing] {
    animation: smrt-admin-shell-slide-to-left
      var(--smrt-admin-shell-chrome-duration) ease-in forwards;
  }

  .smrt-admin-shell__edge--right[data-presentation='overlay'][data-closing] {
    animation: smrt-admin-shell-slide-to-right
      var(--smrt-admin-shell-chrome-duration) ease-in forwards;
  }

  .smrt-admin-shell__overlay-scrim[data-closing] {
    pointer-events: none;
    animation: smrt-admin-shell-scrim-out
      var(--smrt-admin-shell-chrome-duration) ease-in forwards;
  }

  @keyframes smrt-admin-shell-slide-to-right {
    to {
      transform: translateX(100%);
    }
  }

  @keyframes smrt-admin-shell-slide-to-left {
    to {
      transform: translateX(-100%);
    }
  }

  @keyframes smrt-admin-shell-scrim-out {
    to {
      opacity: 0;
    }
  }

  @keyframes smrt-admin-shell-slide-from-right {
    from {
      transform: translateX(100%);
    }
  }

  @keyframes smrt-admin-shell-slide-from-left {
    from {
      transform: translateX(-100%);
    }
  }

  @keyframes smrt-admin-shell-scrim-in {
    from {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .smrt-admin-shell__edge--left[data-presentation='overlay'][data-state='expanded'],
    .smrt-admin-shell__edge--right[data-presentation='overlay'][data-state='expanded'],
    .smrt-admin-shell__edge[data-presentation='overlay'][data-closing],
    .smrt-admin-shell__overlay-scrim {
      animation: none;
    }
  }

  .smrt-admin-shell__sheet-grabber {
    display: grid;
    place-items: center;
    block-size: 1.5rem;
    touch-action: pan-x;
  }

  .smrt-admin-shell__sheet-grabber span {
    inline-size: 2.5rem;
    block-size: 0.25rem;
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-outline-variant);
  }

  /* Phone page contracts: breadcrumbs give way to the top bar, and so does
     the page title (visually hidden: screen readers and the outline keep
     it); page tabs stick under it and slide away with it; a form's action
     row is fixed to the bottom and replaces the bottom bar. */
  .smrt-admin-shell[data-phone-top]:has(
    > .smrt-admin-shell__phone-top :global([data-shell-page-navigation-replacement])
  ) :global([data-shell-breadcrumbs]) {
    display: none;
  }

  .smrt-admin-shell[data-phone-top]:has(
    > .smrt-admin-shell__phone-top :global([data-shell-page-title-replacement])
  ) :global([data-shell-page-title]) {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  /* Tabs inside a page header (a content item's tabs under its title) stick
     like any page tabs: the header's boxes step aside on phones so the tabs'
     sticky range is the page, not the header. */
  .smrt-admin-shell[data-phone-top]
    :global([data-page-header]:has([data-shell-tabs])),
  .smrt-admin-shell[data-phone-top]
    :global([data-page-header-extra]:has([data-shell-tabs])) {
    display: contents;
  }

  .smrt-admin-shell[data-phone-top] :global([data-shell-tabs]) {
    position: sticky;
    inset-block-start: var(--smrt-admin-shell-phone-top-size);
    z-index: 6;
    background: var(--smrt-color-surface);
    transition: transform var(--smrt-admin-shell-chrome-duration)
      var(--smrt-easing-standard, ease);
  }

  .smrt-admin-shell[data-phone-top][data-chrome-hidden]
    :global([data-shell-tabs]) {
    transform: translateY(
      calc(-100% - var(--smrt-admin-shell-phone-top-size))
    );
  }

  .smrt-admin-shell[data-viewport='phone'] :global([data-form-action-bar]) {
    position: fixed;
    inset: auto 0 0;
    z-index: 12;
    display: flex;
    flex-flow: row nowrap;
    align-items: center;
    gap: var(--smrt-spacing-2);
    margin: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-4)
      calc(var(--smrt-spacing-2) + env(safe-area-inset-bottom));
    border-block-start: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
  }

  .smrt-admin-shell[data-viewport='phone'] :global([data-form-action-bar] > *) {
    flex: 1 1 0;
    min-block-size: 2.75rem;
  }

  :global(:root[data-keyboard-open])
    .smrt-admin-shell[data-viewport='phone']
    :global([data-form-action-bar]) {
    display: none;
  }

  .smrt-admin-shell[data-bottom-bar='form'] .smrt-admin-shell__main {
    padding-block-end: calc(5rem + env(safe-area-inset-bottom));
  }

  /* The phone bottom bar sits at the bottom of the dynamic viewport so the
     browser's collapsing toolbar never hides it. */
  .smrt-admin-shell[data-bottom-bar='nav'],
  .smrt-admin-shell[data-bottom-bar='form'] {
    min-block-size: 100dvh;
    block-size: 100dvh;
  }

  @media (max-width: 48rem) {
    .smrt-admin-shell {
      grid-template-columns: 0 minmax(0, 1fr) 0;
      grid-template-rows:
        var(--smrt-admin-shell-header-track)
        var(--smrt-admin-shell-top-track) minmax(0, 1fr)
        var(--smrt-admin-shell-bottom-track)
        var(--smrt-admin-shell-phone-bar-track);
    }

    .smrt-admin-shell__resizer {
      display: none;
    }

    .smrt-admin-shell__tenant-opener { display: block; }
    .smrt-admin-shell__edge--left:not([data-state='expanded']),
    .smrt-admin-shell__edge--right:not([data-state='expanded']) { visibility: hidden; }
    .smrt-admin-shell__edge--left,
    .smrt-admin-shell__edge--right {
      position: absolute;
      grid-area: auto;
      inset-block: calc(
          var(--smrt-admin-shell-header-track) +
            var(--smrt-admin-shell-top-track)
        )
        calc(
          var(--smrt-admin-shell-bottom-track) +
            var(--smrt-admin-shell-phone-bar-track)
        );
      inline-size: min(22rem, 86vw);
      transform: translateX(-100%);
      transition: transform var(--smrt-duration-short2)
        var(--smrt-easing-standard);
    }

    .smrt-admin-shell__edge--left {
      inset-inline-start: 0;
    }

    .smrt-admin-shell__edge--right {
      inset-inline-end: 0;
      transform: translateX(100%);
    }

    .smrt-admin-shell__edge--left[data-state='expanded'],
    .smrt-admin-shell__edge--right[data-state='expanded'] {
      transform: translateX(0);
    }

    /* Right edge as a bottom sheet. */
    .smrt-admin-shell__edge--right[data-phone='sheet'] {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
      inset-inline: 0;
      inset-block-start: calc(
        var(--smrt-admin-shell-header-track) +
          var(--smrt-admin-shell-top-track) + var(--smrt-spacing-8)
      );
      inline-size: auto;
      border-inline-start: 0;
      border-start-start-radius: var(--smrt-radius-lg);
      border-start-end-radius: var(--smrt-radius-lg);
      background: var(--smrt-color-surface);
      box-shadow: var(--smrt-elevation-3);
      transform: translateY(100%);
      visibility: hidden;
      transition:
        transform var(--smrt-duration-short2) var(--smrt-easing-standard),
        visibility 0s linear var(--smrt-duration-short2);
    }

    .smrt-admin-shell__edge--right[data-phone='sheet'][data-state='expanded'] {
      grid-template-columns: minmax(0, 1fr);
      transform: none;
      visibility: visible;
      transition: transform var(--smrt-duration-short2)
        var(--smrt-easing-standard);
    }

    .smrt-admin-shell__edge--right[data-phone='sheet'] .smrt-admin-shell__rail {
      display: none;
    }

    .smrt-admin-shell__edge--right[data-phone='sheet'] .smrt-admin-shell__panel--right {
      grid-column: 1;
      grid-row: 2;
    }

    .smrt-admin-shell__edge--top,
    .smrt-admin-shell__edge--bottom {
      grid-template-columns: minmax(0, 1fr);
    }

    .smrt-admin-shell__band--top,
    .smrt-admin-shell__band--bottom {
      grid-column: 1;
    }

    .smrt-admin-shell__corner {
      display: none;
    }

    .smrt-admin-shell__drawer {
      box-sizing: border-box;
      inset-inline: 0;
    }

    .smrt-admin-shell__drawer--top {
      max-block-size: min(
        var(--smrt-admin-shell-top-expanded),
        calc(100% - var(--smrt-admin-shell-top-track) - var(--smrt-admin-shell-bottom-track))
      );
    }

    .smrt-admin-shell__drawer--bottom {
      max-block-size: min(
        var(--smrt-admin-shell-bottom-expanded),
        calc(100% - var(--smrt-admin-shell-top-track) - var(--smrt-admin-shell-bottom-track))
      );
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .smrt-admin-shell {
      --smrt-admin-shell-chrome-duration: 0ms;
    }

    .smrt-admin-shell__edge--left,
    .smrt-admin-shell__edge--right,
    .smrt-admin-shell__edge--right[data-phone='sheet'],
    .smrt-admin-shell__edge--right[data-phone='sheet'][data-state='expanded'] {
      transition: none;
    }

    .smrt-admin-shell__drawer--bottom {
      animation: none;
    }
  }
</style>
