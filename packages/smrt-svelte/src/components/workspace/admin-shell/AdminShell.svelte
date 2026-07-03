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

function buildLayoutStyle(shell: ModuleShellState): string {
  return [
    `--smrt-admin-shell-left-track: ${trackFor(shell, 'left')}`,
    `--smrt-admin-shell-right-track: ${trackFor(shell, 'right')}`,
    `--smrt-admin-shell-top-track: ${trackFor(shell, 'top')}`,
    `--smrt-admin-shell-bottom-track: ${trackFor(shell, 'bottom')}`,
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
  import { onMount, untrack } from 'svelte';
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
    state?: ShellState;
    appBar?: Snippet;
    appPanel?: Snippet;
    tenantRail?: Snippet;
    tenantPanel?: Snippet;
    focusRail?: Snippet;
    focusPanel?: Snippet;
    systemBar?: Snippet;
    systemPanel?: Snippet;
    topLeftCorner?: Snippet;
    topRightCorner?: Snippet;
    bottomLeftCorner?: Snippet;
    bottomRightCorner?: Snippet;
    shortcutsOverlay?: Snippet;
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
  const activeFocusTool = $derived(
    shell.focusTools.find((tool) => tool.id === shell.activeFocusToolId) ??
      shell.focusTools[0] ??
      null,
  );
  const shortcutEdges: PanelEdge[] = ['top', 'left', 'bottom', 'right'];

  onMount(() => {
    void shell.hydrate();

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
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  const layoutStyle = $derived(buildLayoutStyle(shell));

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
    <kbd class="smrt-admin-shell__edge-toggle-kbd">{hotkeyFor(edge)}</kbd>
    <ActivityBadge {edge} />
  </Button>
{/snippet}

{#snippet focusContent(tool: ShellFocusTool | null)}
  {#if focusPanel}
    {@render focusPanel()}
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
  style={layoutStyle}
>
  {#if panelState('top') !== 'hidden'}
    <header
      id="smrt-admin-shell-top-panel"
      class="smrt-admin-shell__edge smrt-admin-shell__edge--top"
      data-state={panelState('top')}
      data-presentation={shell.config.panels.top.presentation}
    >
      {#if topLeftCorner}
        <div class="smrt-admin-shell__corner smrt-admin-shell__corner--top-left">
          {@render topLeftCorner()}
        </div>
      {/if}
      <div class="smrt-admin-shell__band smrt-admin-shell__band--top">
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

  {#if panelState('left') !== 'hidden'}
    <aside
      id="smrt-admin-shell-left-panel"
      class="smrt-admin-shell__edge smrt-admin-shell__edge--left"
      data-state={panelState('left')}
      data-presentation={shell.config.panels.left.presentation}
      role="navigation"
      aria-label={labelFor('left')}
    >
      <div class="smrt-admin-shell__rail">
        {#if edgeExpanded('left')}
          {#if tenantPanel}
            {@render tenantPanel()}
          {:else if tenantRail}
            {@render tenantRail()}
          {:else}
            {@render edgeToggle('left')}
          {/if}
        {:else if tenantRail}
          {@render tenantRail()}
        {:else}
          {@render edgeToggle('left')}
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
      class="smrt-admin-shell__edge smrt-admin-shell__edge--right"
      data-state={panelState('right')}
      data-presentation={shell.config.panels.right.presentation}
      aria-label={labelFor('right')}
    >
      <div class="smrt-admin-shell__rail">
        {#if edgeExpanded('right')}
          {@render focusContent(activeFocusTool)}
        {:else if focusRail}
          {@render focusRail()}
        {:else}
          {@render edgeToggle('right')}
        {/if}
      </div>
    </aside>
  {/if}

  {#if panelState('bottom') !== 'hidden'}
    <footer
      id="smrt-admin-shell-bottom-panel"
      class="smrt-admin-shell__edge smrt-admin-shell__edge--bottom"
      data-state={panelState('bottom')}
      data-presentation={shell.config.panels.bottom.presentation}
    >
      {#if bottomLeftCorner}
        <div class="smrt-admin-shell__corner smrt-admin-shell__corner--bottom-left">
          {@render bottomLeftCorner()}
        </div>
      {/if}
      <div class="smrt-admin-shell__band smrt-admin-shell__band--bottom">
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
    grid-template-columns:
      var(--smrt-admin-shell-left-track) minmax(0, 1fr)
      var(--smrt-admin-shell-right-track);
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

  .smrt-admin-shell__edge--bottom {
    grid-column: 1 / -1;
    grid-row: 3;
    display: grid;
    grid-template-columns:
      var(--smrt-admin-shell-left-track) minmax(0, 1fr)
      var(--smrt-admin-shell-right-track);
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
    grid-column: 2;
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
    min-width: 0;
    min-height: 0;
    block-size: 100%;
    overflow: auto;
    padding: var(--smrt-spacing-3);
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
    inset-inline: var(--smrt-admin-shell-left-track)
      var(--smrt-admin-shell-right-track);
    max-block-size: var(--smrt-admin-shell-bottom-expanded);
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

    .smrt-admin-shell__edge--left,
    .smrt-admin-shell__edge--right {
      position: absolute;
      inset-block: var(--smrt-admin-shell-top-track)
        var(--smrt-admin-shell-bottom-track);
      inline-size: min(22rem, 86vw);
      transform: translateX(-100%);
      transition: transform var(--smrt-duration-short2)
        var(--smrt-easing-standard);
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
  }

  @media (prefers-reduced-motion: reduce) {
    .smrt-admin-shell__edge--left,
    .smrt-admin-shell__edge--right {
      transition: none;
    }
  }
</style>
