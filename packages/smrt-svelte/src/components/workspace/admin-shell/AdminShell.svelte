<script lang="ts" module>
import type { ShellState as ModuleShellState } from './state.svelte.js';
import type { PanelEdge as ModulePanelEdge } from './types.js';

function trackFor(shell: ModuleShellState, edge: ModulePanelEdge): string {
  const state = shell.panels[edge];
  const config = shell.config.panels[edge];
  if (state === 'hidden') return '0rem';
  if (state === 'collapsed') return config.collapsedSize;
  if (config.presentation === 'overlay') return config.collapsedSize;
  return config.expandedSize;
}

function expandedSize(shell: ModuleShellState, edge: ModulePanelEdge): string {
  return shell.config.panels[edge].expandedSize;
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
  import { useI18n } from '@happyvertical/smrt-ui/i18n';
  import { Button } from '@happyvertical/smrt-ui/ui';
  import { onMount, tick, untrack } from 'svelte';
  import type { Snippet } from 'svelte';
  import { M } from '../../../i18n/strings.workspace.js';
  import ActivityBadge from './ActivityBadge.svelte';
  import { setAdminShell } from './context.js';
  import {
    formatHotkeyBinding,
    shellActionFromKeyboardEvent,
  } from './hotkeys.js';
  import { resolveHotkey } from './settings.js';
  import { createShellState, type ShellState } from './state.svelte.js';
  import type {
    AdminShellProps,
    PanelEdge,
    ShellFocusTool,
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
    children: Snippet;
  }

  let {
    title = 'SMRT',
    homeHref,
    showTenantToggle = true,
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
  let narrow = $state(false);
  let leftPanelEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const panel = leftPanelEl;
    if (!narrow || !edgeExpanded('left') || !panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    void tick().then(async () => {
      // Inherited visibility also transitions on primitive buttons; wait for
      // the drawer and its controls to be focusable before moving focus.
      await Promise.all(panel.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
      if (cancelled || !narrow || !edgeExpanded('left') || !panel.isConnected) return;
      panel.querySelector<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus();
    });
    return () => { cancelled = true; queueMicrotask(() => { if (opener?.isConnected) opener.focus(); }); };
  });
  function resolveActiveFocusTool(): ShellFocusTool | null {
    return (
      shell.focusTools.find((tool) => tool.id === shell.activeFocusToolId) ??
      shell.focusTools[0] ??
      null
    );
  }
  const shortcutEdges: PanelEdge[] = ['top', 'left', 'bottom', 'right'];

  onMount(() => {
    void shell.hydrate();
    const media = window.matchMedia('(max-width: 48rem)');
    const updateNarrow = () => { narrow = media.matches; };
    updateNarrow();
    media.addEventListener('change', updateNarrow);

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
    return () => { window.removeEventListener('keydown', handleKeydown); media.removeEventListener('change', updateNarrow); };
  });

  const footerInHeader = $derived(!account && !!tenantFooter && !edgeExpanded('left'));

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

{#snippet brandContent(compact: boolean)}
  {#if brand}
    {@render brand({ compact })}
  {:else}
    {#if logoSrc}<img class="smrt-admin-shell__logo" src={logoSrc} alt={logoAlt} />{/if}
    {#if compact}
      {#if !logoSrc}<span aria-hidden="true">{title.charAt(0)}</span>{/if}
    {:else}
      <div class="smrt-admin-shell__brand-text"><strong>{title}</strong>{#if subtitle}<span>{subtitle}</span>{/if}</div>
    {/if}
  {/if}
{/snippet}

{#snippet shellBrand(compact = false)}
  {#if homeHref}
    <a class="smrt-admin-shell__brand smrt-admin-shell__brand-link" class:compact href={homeHref} aria-label={title || t(M['ui.admin_shell.home'])}>
      {@render brandContent(compact)}
    </a>
  {:else}
    <div class="smrt-admin-shell__brand" class:compact>{@render brandContent(compact)}</div>
  {/if}
{/snippet}

<div
  class="smrt-admin-shell"
  data-top-state={panelState('top')}
  data-left-state={panelState('left')}
  data-right-state={panelState('right')}
  data-bottom-state={panelState('bottom')}
  style={layoutStyle}
>
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
          {@render shellBrand()}
          {@render edgeToggle('top')}
        {/if}
        {#if shell.config.panels.left.initial !== 'hidden'}
          <div class="smrt-admin-shell__tenant-opener" class:restore-hidden={panelState('left') === 'hidden'}>
            <Button variant="ghost" size="sm" aria-label={t(M['ui.admin_shell.menu'])} aria-expanded={edgeExpanded('left')} aria-controls="smrt-admin-shell-left-panel" onclick={() => shell.setPanelState('left', edgeExpanded('left') ? 'collapsed' : 'expanded')}>{t(M['ui.admin_shell.menu'])}</Button>
          </div>
        {/if}
        {#if account || footerInHeader}
          <div class="smrt-admin-shell__account">
            {#if account}{@render account()}{:else if tenantFooter}{@render tenantFooter()}{/if}
          </div>
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

  {#if panelState('left') !== 'hidden'}
    <aside
      id="smrt-admin-shell-left-panel"
      bind:this={leftPanelEl}
      inert={narrow && !edgeExpanded('left')}
      class="smrt-admin-shell__edge smrt-admin-shell__edge--left"
      data-state={panelState('left')}
      data-presentation={shell.config.panels.left.presentation}
      role="navigation"
      aria-label={labelFor('left')}
    >
      <div class="smrt-admin-shell__rail">
        {#if !edgeExpanded('left') && (homeHref || logoSrc || brand)}{@render shellBrand(true)}{/if}
        {#if showTenantToggle}{@render edgeToggle('left')}{/if}
        {#if edgeExpanded('left')}
          <div class="smrt-admin-shell__tenant-stack">
            <div class="smrt-admin-shell__tenant-content">
              {#if tenantPanel}
                {@render tenantPanel()}
              {:else if tenantRail}
                {@render tenantRail()}
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
        {/if}
      </div>
    </aside>
  {/if}

  <main class="smrt-admin-shell__main">
    {@render children()}
  </main>

  {#if panelState('right') !== 'hidden'}
    <aside
      id="smrt-admin-shell-right-panel"
      inert={narrow && !edgeExpanded('right')}
      class="smrt-admin-shell__edge smrt-admin-shell__edge--right"
      data-state={panelState('right')}
      data-presentation={shell.config.panels.right.presentation}
      aria-label={labelFor('right')}
    >
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
        {#if systemBar}{@render systemBar()}{/if}
        {@render edgeToggle('bottom')}
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
    position: relative;
    display: grid;
    grid-template-columns:
      var(--smrt-admin-shell-left-track) minmax(0, 1fr)
      var(--smrt-admin-shell-right-track);
    grid-template-rows:
      var(--smrt-admin-shell-top-track) minmax(0, 1fr)
      var(--smrt-admin-shell-bottom-track);
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

  .smrt-admin-shell__edge--top {
    grid-column: 1 / -1;
    grid-row: 1;
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
    grid-column: 1;
    grid-row: 2;
    border-inline-end: 1px solid var(--smrt-color-outline-variant);
    z-index: 20;
  }

  .smrt-admin-shell__edge--right {
    grid-column: 3;
    grid-row: 2;
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
    grid-row: 3;
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
    grid-row: 2;
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
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }
  .smrt-admin-shell__brand-text { display: grid; min-width: 0; }
  .smrt-admin-shell__brand.compact { justify-content: center; margin-block-end: var(--smrt-spacing-2); }
  .smrt-admin-shell__brand-link:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .smrt-admin-shell__logo { inline-size: 2rem; block-size: 2rem; object-fit: contain; flex-shrink: 0; }

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
  }

  .smrt-admin-shell__tenant-stack {
    flex: 1;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    gap: var(--smrt-spacing-3);
    min-width: 0;
    min-height: 0;
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
    inset-block-start: var(--smrt-admin-shell-top-track);
    inset-inline: var(--smrt-admin-shell-left-track)
      var(--smrt-admin-shell-right-track);
    max-block-size: var(--smrt-admin-shell-top-expanded);
  }

  .smrt-admin-shell__drawer--bottom {
    inset-block-end: var(--smrt-admin-shell-bottom-track);
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

  @media (max-width: 48rem) {
    .smrt-admin-shell {
      grid-template-columns: 0 minmax(0, 1fr) 0;
      grid-template-rows:
        var(--smrt-admin-shell-top-track) minmax(0, 1fr)
        var(--smrt-admin-shell-bottom-track);
    }

    .smrt-admin-shell__tenant-opener { display: block; }
    .smrt-admin-shell__edge--left:not([data-state='expanded']),
    .smrt-admin-shell__edge--right:not([data-state='expanded']) { visibility: hidden; }
    .smrt-admin-shell__edge--left,
    .smrt-admin-shell__edge--right {
      position: absolute;
      grid-area: auto;
      inset-block: var(--smrt-admin-shell-top-track)
        var(--smrt-admin-shell-bottom-track);
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
    .smrt-admin-shell__edge--left,
    .smrt-admin-shell__edge--right {
      transition: none;
    }

    .smrt-admin-shell__drawer--bottom {
      animation: none;
    }
  }
</style>
