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
  const config = shell.config.panels[edge];
  if (state === 'hidden') return '0rem';
  if (state === 'collapsed') return config.collapsedSize;
  if (config.presentation === 'overlay') return config.collapsedSize;
  return expandedSize(shell, edge);
}

function collapsedSize(shell: ModuleShellState, edge: ModulePanelEdge): string {
  if (shell.panels[edge] === 'hidden') return '0rem';
  return shell.config.panels[edge].collapsedSize;
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
  import { onMount, untrack } from 'svelte';
  import type { Snippet } from 'svelte';
  import { M } from '../../../i18n/strings.workspace.js';
  import ActivityBadge from './ActivityBadge.svelte';
  import { setAdminShell } from './context.js';
  import {
    formatHotkeyBinding,
    shellActionFromKeyboardEvent,
  } from './hotkeys.js';
  import { type BottomBarMode, bottomBarMode } from './mobile-shell.js';
  import {
    installKeyboardWatcher,
    installScrollChrome,
    installShellViewport,
    watchFormActionBar,
  } from './mobile-shell-dom.js';
  import { clampPanelSize, resolveHotkey } from './settings.js';
  import { createShellState, type ShellState } from './state.svelte.js';
  import type {
    AdminShellPhoneOptions,
    AdminShellProps,
    PanelEdge,
    ShellFocusTool,
    ShellViewport,
  } from './types.js';

  interface Props extends AdminShellProps {
    /** Pre-configured shell state. Creates one from config if omitted. */
    state?: ShellState;
    /** Content for the top app bar. */
    appBar?: Snippet;
    /** Content for the main app panel. */
    appPanel?: Snippet;
    /** Content for the left tenant rail. */
    tenantRail?: Snippet;
    /** Content for the left tenant panel. */
    tenantPanel?: Snippet;
    /** Content for the tenant panel footer. */
    tenantFooter?: Snippet;
    /** Content for the right focus rail. */
    focusRail?: Snippet;
    /** Content for the right focus panel, receives the active tool. */
    focusPanel?: Snippet<[{ tool: ShellFocusTool | null }]>;
    /** Content for the system bar. */
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
    subtitle = '',
    config,
    settings,
    settingsAdapter,
    storageKey = 'smrt-admin-shell',
    state: providedState,
    appBar,
    appPanel,
    tenantRail,
    tenantPanel,
    tenantFooter,
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
  const showPhoneTop = $derived(isPhone && Boolean(phoneTopBar));
  const showHeader = $derived(Boolean(header) && !showPhoneTop);
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
  const chromeStyle = $derived(
    [
      `--smrt-admin-shell-header-track: ${showHeader ? 'var(--smrt-admin-shell-header-size)' : '0rem'}`,
      `--smrt-admin-shell-phone-bar-track: ${bottomBar === 'nav' ? 'var(--smrt-admin-shell-phone-bar-size)' : '0rem'}`,
    ].join('; '),
  );

  function collapsePhoneSurfaces(): void {
    for (const edge of SIDE_EDGES) {
      if (panelState(edge) === 'expanded' && shell.isEdgeShown(edge)) {
        shell.collapsePanel(edge);
      }
    }
  }

  onMount(() => {
    void shell.hydrate();
    const offViewport = installShellViewport(shell);
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
        if (shell.closeTopmostExpanded()) event.preventDefault();
        return;
      }

      const action = shellActionFromKeyboardEvent(
        event,
        shell.config.panels,
        shell.settings,
      );
      if (!action) return;
      event.preventDefault();
      if (action.type === 'show-shortcuts') {
        shortcutsOpen = true;
      } else {
        shell.togglePanel(action.edge);
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      offViewport();
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
      shell.config.panels[edge].presentation === 'push' &&
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

  function onResizePointerdown(event: PointerEvent, edge: SideEdge): void {
    if (event.button !== 0 || !shell.resizeLimits(edge)) return;
    event.preventDefault();
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

    function onEnd(): void {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      if (pointerId !== undefined && handle.hasPointerCapture?.(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      resizing = null;
      if (latest !== startSize) shell.setPanelSize(edge, latest);
    }

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  }

  const layoutStyle = $derived(buildLayoutStyle(shell));

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

  function labelFor(edge: PanelEdge): string {
    return shell.config.panels[edge].label;
  }

  function hotkeyFor(edge: PanelEdge): string {
    return formatHotkeyBinding(
      resolveHotkey(edge, shell.config.panels[edge], shell.settings),
    );
  }

  function showsHotkeyFor(edge: PanelEdge): boolean {
    return (
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
    aria-expanded={edgeExpanded(edge)}
    aria-controls={`smrt-admin-shell-${edge}-panel`}
    onclick={() => shell.togglePanel(edge)}
  >
    <span>{labelFor(edge)}</span>
    {#if showsHotkeyFor(edge)}
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

<div
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
  style={`${layoutStyle}; ${chromeStyle}`}
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
          <div class="smrt-admin-shell__brand">
            <strong>{title}</strong>
            {#if subtitle}
              <span>{subtitle}</span>
            {/if}
          </div>
          {@render edgeToggle('top')}
        {/if}
      </div>
      {#if topRightCorner}
        <div class="smrt-admin-shell__corner smrt-admin-shell__corner--top-right">
          {@render topRightCorner()}
        </div>
      {/if}
      {#if edgeExpanded('top')}
        <section
          class="smrt-admin-shell__drawer smrt-admin-shell__drawer--top"
          aria-label={labelFor('top')}
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

  {#if shell.isEdgeShown('left')}
    <aside
      id="smrt-admin-shell-left-panel"
      class="smrt-admin-shell__edge smrt-admin-shell__edge--left"
      data-state={panelState('left')}
      data-presentation={shell.config.panels.left.presentation}
      role="navigation"
      aria-label={labelFor('left')}
      bind:this={sideElements.left}
      use:swipeDismiss={{
        direction: 'left',
        onDismiss: () => shell.collapsePanel('left'),
        enabled: isPhone && Boolean(phone?.swipeToClose) && edgeExpanded('left'),
      }}
    >
      {@render resizer('left')}
      <div class="smrt-admin-shell__rail">
        {#if edgeExpanded('left')}
          <div class="smrt-admin-shell__tenant-stack">
            <div class="smrt-admin-shell__tenant-content">
              {#if tenantPanel}
                {@render tenantPanel()}
              {:else if tenantRail}
                {@render tenantRail()}
              {:else}
                {@render edgeToggle('left')}
              {/if}
            </div>
            {#if tenantFooter}
              <div class="smrt-admin-shell__tenant-footer">
                {@render tenantFooter()}
              </div>
            {/if}
          </div>
        {:else if tenantRail}
          {@render tenantRail()}
        {:else}
          {@render edgeToggle('left')}
        {/if}
      </div>
    </aside>
  {/if}

  <main
    id="smrt-admin-shell-main"
    class="smrt-admin-shell__main"
    bind:this={mainElement}
  >
    {@render children()}
  </main>

  {#if showPhoneTop}
    <div class="smrt-admin-shell__phone-top" data-testid="admin-shell-phone-top">
      {@render phoneTopBar?.({ hidden: chromeHidden })}
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

  {#if shell.isEdgeShown('right')}
    {@const rightPhone = isPhone ? shell.phonePresentation('right') : undefined}
    <aside
      id="smrt-admin-shell-right-panel"
      class="smrt-admin-shell__edge smrt-admin-shell__edge--right"
      data-state={panelState('right')}
      data-presentation={shell.config.panels.right.presentation}
      data-phone={rightPhone}
      aria-label={labelFor('right')}
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
        {#if focusRail}
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
        {:else}
          {@render edgeToggle('right')}
        {/if}
      </div>
      {#if edgeExpanded('right')}
        <div class="smrt-admin-shell__panel smrt-admin-shell__panel--right">
          {#key shell.activeFocusToolId}
            {@render focusContent(resolveActiveFocusTool())}
          {/key}
        </div>
      {/if}
    </aside>
  {/if}

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
        {#if systemBar}
          {@render systemBar()}
        {:else}
          {@render edgeToggle('bottom')}
        {/if}
      </div>
      {#if bottomRightCorner}
        <div class="smrt-admin-shell__corner smrt-admin-shell__corner--bottom-right">
          {@render bottomRightCorner()}
        </div>
      {/if}
      {#if edgeExpanded('bottom')}
        <section
          class="smrt-admin-shell__drawer smrt-admin-shell__drawer--bottom"
          aria-label={labelFor('bottom')}
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
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    overflow: hidden;
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
    padding: 0 var(--smrt-spacing-3) 0 var(--smrt-spacing-2);
    overflow: hidden;
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
    background: var(--smrt-color-surface);
  }

  .smrt-admin-shell__band {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
    min-width: 0;
    padding: 0 var(--smrt-spacing-4);
  }

  .smrt-admin-shell__band--top,
  .smrt-admin-shell__band--bottom {
    grid-column: var(--band-column, 2);
  }

  .smrt-admin-shell__brand {
    display: grid;
    min-width: 0;
  }

  .smrt-admin-shell__brand strong,
  .smrt-admin-shell__brand span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .smrt-admin-shell__brand span,
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

  .smrt-admin-shell__tenant-stack {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    gap: var(--smrt-spacing-3);
    min-width: 0;
    min-height: 0;
    block-size: 100%;
  }

  .smrt-admin-shell__tenant-content {
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .smrt-admin-shell__tenant-footer {
    min-width: 0;
    padding-block-start: var(--smrt-spacing-3);
    border-block-start: 1px solid var(--smrt-color-outline-variant);
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
      transform: translateY(100%);
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
    transition: transform var(--smrt-admin-shell-chrome-duration)
      var(--smrt-easing-standard, ease);
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
  .smrt-admin-shell[data-viewport='phone'] :global([data-shell-breadcrumbs]) {
    display: none;
  }

  .smrt-admin-shell[data-phone-top] :global([data-shell-page-title]) {
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
