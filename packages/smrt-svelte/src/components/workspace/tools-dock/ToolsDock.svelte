<script lang="ts" module>
/**
 * ToolsDock - renderer for the tools dock.
 *
 * Consumes a {@link ToolsDockInstance} produced by {@link defineToolsDock}
 * and renders either:
 *   - layout='rail'   → a vertical icon rail (right edge) + a sliding panel
 *     contained inside the dock's own aside (no fixed positioning at the
 *     viewport level — safe to compose alongside `<WorkspaceShell>`'s
 *     `inspector` snippet).
 *   - layout='topbar' → inline activation buttons + a SEPARATE floating
 *     `position: fixed` panel anchored to the bottom-right (z-index `40`).
 *     **Do not also use `<WorkspaceShell>`'s `inspector` snippet in this
 *     mode** — the shell renders its own `position: fixed` inspector with
 *     no z-index coordination against the dock, and the two panels will
 *     visibly overlap. Render `<ToolsDock layout='topbar'>` inside the
 *     shell's `topbarActions` snippet and leave `inspector` unused.
 *
 * The component takes care of:
 *   - registering the dock on Svelte context (via the factory) so descendants
 *     can call {@link useToolsDock}
 *   - hydrating persisted state on mount (SSR-safe)
 *   - persisting state changes back to localStorage when `storageKey` is set
 *   - Escape-to-close + focus restoration to the activating button
 *   - reflecting active tool via aria-current and a polite live region
 *   - showing an empty-state when no tools pass the availability filter
 */
</script>

<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { M } from '../../../i18n/strings.workspace.js';
  import { useI18n } from '@happyvertical/smrt-ui/i18n';
  import { Button } from '@happyvertical/smrt-ui/ui';
  import type { ToolsDockContext } from '../types.js';
  import type { ToolsDockInstance } from './define-tools-dock.svelte.js';

  const { t } = useI18n();

  interface Props {
    /** Instance produced by `defineToolsDock(...)`. */
    dock: ToolsDockInstance;
    /** Optional initial context. Alternative to calling `dock.setContext()` directly. */
    context?: ToolsDockContext | null;
    /** Optional override label for the open/close rail toggle, for a11y. */
    closeLabel?: string;
  }

  let { dock, context = undefined, closeLabel = 'Close tools panel' }: Props =
    $props();

  // Forward the `context` prop into the dock fully reactively: every time
  // the prop changes (including from `undefined` to a populated value
  // supplied by async route data), push it through.
  //
  // Safe to run inside an effect because:
  //   - `dock.setContext` short-circuits on a strict-equal context, so
  //     calling it repeatedly with the same reference is a true no-op
  //     (no availability refetch, no 'dock:change' emit).
  //   - the dock's `emitChange` reads `$state` values inside `untrack`, so
  //     subsequent `open()` / `close()` mutations do not retrigger this
  //     effect via the 'dock:change' payload.
  $effect(() => {
    if (context !== undefined) {
      dock.setContext(context);
    }
  });

  let lastActivatorEl: HTMLButtonElement | null = null;
  const announcement = $derived(
    dock.isOpen && dock.activeTool
      ? `${labelFor(dock.activeTool)} tool opened`
      : '',
  );

  function labelFor(toolId: string): string {
    return (
      dock.availableTools.find((t) => t.id === toolId)?.label ??
      dock.tools.find((t) => t.id === toolId)?.label ??
      toolId
    );
  }

  function activeToolDef() {
    if (!dock.activeTool) return null;
    return dock.tools.find((t) => t.id === dock.activeTool) ?? null;
  }

  function toolDefById(id: string) {
    return dock.tools.find((t) => t.id === id) ?? null;
  }

  function handleButtonClick(event: MouseEvent, toolId: string): void {
    lastActivatorEl = event.currentTarget as HTMLButtonElement;
    dock.toggle(toolId);
  }

  function handleClose(): void {
    dock.close();
    // Restore focus to the last activator (if still mounted).
    void tick().then(() => {
      lastActivatorEl?.focus();
    });
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && dock.isOpen) {
      event.preventDefault();
      handleClose();
    }
  }

  onMount(() => {
    dock.hydrate();
  });

  // Persist whenever isOpen/activeTool change (defineToolsDock also persists
  // on its mutators; this catches external set-via-getter writes if any).
  //
  // The first effect run fires synchronously *after* `onMount(() => dock.hydrate())`
  // applies persisted state, so we skip it: writing the hydrated values right
  // back to storage is benign in the common case, but if `hydrate()` rejected
  // a stale `activeTool` (no longer registered) while `isOpen` was true, that
  // first persist would silently clear `activeTool` on reload.
  let lastIsOpen: boolean | undefined;
  let lastActive: string | null | undefined;
  let firstPersistRun = true;
  $effect(() => {
    // Read both reactive values to register dependencies before any branch.
    const nextIsOpen = dock.isOpen;
    const nextActive = dock.activeTool;
    if (firstPersistRun) {
      lastIsOpen = nextIsOpen;
      lastActive = nextActive;
      firstPersistRun = false;
      return;
    }
    if (nextIsOpen !== lastIsOpen || nextActive !== lastActive) {
      lastIsOpen = nextIsOpen;
      lastActive = nextActive;
      dock.persist();
    }
  });

  let removeKeydown: (() => void) | null = null;
  onMount(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: KeyboardEvent) => handleKeydown(e);
    window.addEventListener('keydown', handler);
    removeKeydown = () => window.removeEventListener('keydown', handler);
  });
  onDestroy(() => {
    removeKeydown?.();
  });
</script>

{#snippet toolButton(tool: { id: string; label?: string; badge?: number | string | null }, variant: 'rail' | 'topbar')}
  {@const isActive = dock.isOpen && dock.activeTool === tool.id}
  {@const label = tool.label ?? tool.id}
  {@const def = toolDefById(tool.id)}
  {@const IconComponent = def?.iconComponent}
  {@const iconString = def?.icon}
  <!-- raw-primitive-allow: dock tool-selector toggle (aria-pressed) with variant-dependent rail/topbar styling, part of the ToolsDock segmented control; not a standard action button -->
  <button
    type="button"
    class:smrt-tools-dock__active={isActive}
    class={variant === 'rail' ? 'smrt-tools-dock__rail-button' : 'smrt-tools-dock__topbar-button'}
    data-smrt-part="trigger"
    aria-pressed={isActive}
    aria-label={`${label} tool`}
    title={label}
    onclick={(event) => handleButtonClick(event, tool.id)}
  >
    {#if variant === 'topbar'}
      {#if IconComponent}
        <span class="smrt-tools-dock__topbar-button-icon" aria-hidden="true" data-smrt-part="icon">
          <IconComponent />
        </span>
      {:else if iconString}
        <span class="smrt-tools-dock__topbar-button-icon" aria-hidden="true" data-smrt-part="icon">
          {iconString}
        </span>
      {/if}
      <span class="smrt-tools-dock__topbar-button-label" data-smrt-part="label">{label}</span>
    {:else}
      <span class="smrt-tools-dock__rail-glyph" aria-hidden="true" data-smrt-part="icon">
        {#if IconComponent}
          <IconComponent />
        {:else if iconString}
          {iconString}
        {:else}
          {label?.charAt(0).toUpperCase() ?? '?'}
        {/if}
      </span>
    {/if}
    {#if tool.badge !== null && tool.badge !== undefined && tool.badge !== 0 && tool.badge !== ''}
      <span class="smrt-tools-dock__badge" data-smrt-part="badge">{tool.badge}</span>
    {/if}
  </button>
{/snippet}

{#snippet panel()}
  {@const ActiveTool = activeToolDef()?.component}
  <div
    class="smrt-tools-dock__panel"
    class:smrt-tools-dock__panel--open={dock.isOpen}
    role="dialog"
    aria-label={dock.activeTool ? `${labelFor(dock.activeTool)} tool panel` : 'Tools panel'}
    aria-modal="false"
    aria-hidden={!dock.isOpen}
    inert={!dock.isOpen} data-smrt-part="panel"
  >
    <header class="smrt-tools-dock__panel-header" data-smrt-part="header">
      <h3>{dock.activeTool ? labelFor(dock.activeTool) : 'Tools'}</h3>
      <Button
        variant="ghost"
        size="sm"
        class="smrt-tools-dock__close"
        onclick={handleClose}
        aria-label={closeLabel}
        title={closeLabel}
      >
        ×
      </Button>
    </header>

    <div class="smrt-tools-dock__panel-body" data-smrt-part="body">
      {#if dock.availableTools.length === 0}
        <div class="smrt-tools-dock__empty" data-smrt-part="empty">
          <strong>{t(M['ui.tools_dock.no_tools_available'])}</strong>
          <p>{t(M['ui.tools_dock.no_tools_context'])}</p>
        </div>
      {:else if ActiveTool}
        <ActiveTool context={dock.context} {dock} />
      {:else}
        <div class="smrt-tools-dock__empty" data-smrt-part="empty">
          <p>{t(M['ui.tools_dock.select_tool'])}</p>
        </div>
      {/if}
    </div>
  </div>
{/snippet}

<!-- Polite live region announces tool transitions for screen readers. -->
<div class="smrt-tools-dock__sr-only" role="status" aria-live="polite" data-smrt-component="ToolsDock">{announcement}</div>

{#if dock.layout === 'topbar'}
  <div class="smrt-tools-dock__root smrt-tools-dock__topbar-mode" data-smrt-component="ToolsDock">
    <nav class="smrt-tools-dock__topbar" aria-label={t(M['ui.tools_dock.workspace_tools'])} data-smrt-part="header">
      {#each dock.availableTools as tool (tool.id)}
        {@render toolButton(tool, 'topbar')}
      {/each}
    </nav>
    {#if dock.isOpen}
      {@render panel()}
    {/if}
  </div>
{:else}
  <aside class="smrt-tools-dock__root smrt-tools-dock__rail-mode" class:smrt-tools-dock__open={dock.isOpen} data-smrt-component="ToolsDock">
    {#if dock.isOpen}
      <!-- raw-primitive-allow: click-catching overlay/backdrop that closes the dock; a structural full-bleed surface, not a styled action button -->
      <button
        type="button"
        class="smrt-tools-dock__overlay"
        aria-label={closeLabel}
        onclick={handleClose} data-smrt-part="scrim"
      ></button>
    {/if}
    {@render panel()}
    <nav class="smrt-tools-dock__rail" aria-label={t(M['ui.tools_dock.workspace_tools'])} data-smrt-part="rail">
      {#each dock.availableTools as tool (tool.id)}
        {@render toolButton(tool, 'rail')}
      {/each}
    </nav>
  </aside>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-tools-dock__root {
    --smrt-tools-dock-rail-width: 3.25rem;
    --smrt-tools-dock-panel-width: 420px;
    box-sizing: border-box;
  }
  /* ---------- Rail layout ---------- */
  .smrt-tools-dock__rail-mode {
    position: sticky;
    top: 0;
    align-self: flex-start;
    z-index: 20;
    height: 100vh;
    width: var(--smrt-tools-dock-rail-width);
    flex: 0 0 var(--smrt-tools-dock-rail-width);
    display: block;
  }
  .smrt-tools-dock__rail {
    position: relative;
    z-index: 2;
    width: var(--smrt-tools-dock-rail-width);
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 0.6rem 0.45rem;
  }
  .smrt-tools-dock__rail-button {
    position: relative;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    display: inline-grid;
    place-items: center;
    cursor: pointer;
  }
  .smrt-tools-dock__badge {
    position: absolute;
    top: 0.18rem;
    right: 0.12rem;
    min-width: 0.85rem;
    height: 0.85rem;
    padding: 0 0.18rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  /* ---------- Panel ---------- */
  .smrt-tools-dock__panel {
    position: absolute;
    inset: 0 var(--smrt-tools-dock-rail-width) 0 auto;
    height: 100%;
    width: var(--smrt-tools-dock-panel-width);
    min-width: var(--smrt-tools-dock-panel-width);
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 1rem;
    overflow: hidden;
    transform: translateX(calc(100% + var(--smrt-tools-dock-rail-width)));
    opacity: 0;
    pointer-events: none;
    will-change: transform;
    contain: layout paint style;
  }
  .smrt-tools-dock__rail-mode.smrt-tools-dock__open .smrt-tools-dock__panel,
  .smrt-tools-dock__panel--open {
    transform: translateX(0);
    opacity: 1;
    pointer-events: auto;
  }
  .smrt-tools-dock__panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .smrt-tools-dock__panel-header h3 {
    margin: 0;
  }
  .smrt-tools-dock__panel-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  /* The close control now renders through smrt-ui <Button>; pierce Svelte
  scoping into the child-rendered <button> with `:global` (#1589). */
  .smrt-tools-dock__panel-header :global(.smrt-tools-dock__close) {
    width: 2rem;
    height: 2rem;
    display: inline-grid;
    place-items: center;
  }
  .smrt-tools-dock__empty {
    display: grid;
    align-content: center;
    gap: 0.45rem;
    min-height: 12rem;
    padding: 1rem;
  }
  .smrt-tools-dock__empty p {
    margin: 0;
  }
  .smrt-tools-dock__overlay {
    display: none;
  }
  /* ---------- Topbar layout ---------- */
  .smrt-tools-dock__topbar-mode {
    display: contents;
  }
  .smrt-tools-dock__topbar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .smrt-tools-dock__topbar-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.7rem;
    cursor: pointer;
  }
  /* Leading glyph in the topbar layout. Sized to match the surrounding
  text — consumers wanting a different size can wrap their icon
  component to hard-code dimensions (see ToolDef.iconComponent docs). */
  .smrt-tools-dock__topbar-button-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-tools-dock__topbar-mode .smrt-tools-dock__panel {
    position: fixed;
    inset: auto 1rem 1rem auto;
    height: min(70vh, 600px);
    z-index: 40;
  }
  /* ---------- A11y helpers ---------- */
  .smrt-tools-dock__sr-only {
    position: absolute;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  /* ---------- Mobile (drawer) ---------- */
  @media (max-width: 960px) {
    .smrt-tools-dock__overlay {
      display: block;
      position: fixed;
      inset: 0;
      z-index: var(--smrt-z-index-overlay, 1200);
      padding: 0;
      cursor: default;
    }
    .smrt-tools-dock__rail-mode {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: var(--smrt-tools-dock-rail-width);
      height: 100vh;
      height: 100dvh;
      z-index: var(--smrt-z-index-modal, 1300);
      --smrt-tools-dock-panel-width: min(420px, calc(100vw - var(--smrt-tools-dock-rail-width)));
    }
    /* Mobile: keep panel and rail above the close overlay so taps reach the
    tool UI. The overlay sits at z-index 65 and previously rendered above
    the panel (no z-index) and rail (z-index: 2) within the same stacking
    context — every tap hit the close button instead of the tool. */
    .smrt-tools-dock__panel {
      z-index: var(--smrt-z-index-modal, 1300);
    }
    .smrt-tools-dock__rail {
      z-index: var(--smrt-z-index-modal, 1300);
    }
  }
  @media (max-width: 640px) {
    .smrt-tools-dock__rail-mode {
      --smrt-tools-dock-panel-width: calc(100vw - var(--smrt-tools-dock-rail-width));
    }
    .smrt-tools-dock__panel {
      padding: 0.85rem;
    }
  }
}

@layer smrt.theme {
  .smrt-tools-dock__root {
    color: var(--smrt-color-on-surface);
  }
  .smrt-tools-dock__rail {
    background: var(--smrt-color-surface-container-low);
    border-left: var(--smrt-hairline);
  }
  .smrt-tools-dock__rail-button {
    border: 1px solid transparent;
    border-radius: 0.45rem;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-tools-dock__rail-button:hover,
  .smrt-tools-dock__rail-button.smrt-tools-dock__active {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
  }
  .smrt-tools-dock__rail-button:focus-visible,
  .smrt-tools-dock__topbar-button:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }
  .smrt-tools-dock__rail-glyph {
    font-size: var(--smrt-typography-body-large-size, 0.95rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    line-height: 1;
  }
  .smrt-tools-dock__badge {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font-size: var(--smrt-typography-label-small-size, 0.58rem);
    font-weight: var(--smrt-typography-weight-bold, 750);
    line-height: 1;
  }
  /* ---------- Panel ---------- */
  .smrt-tools-dock__panel {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    border-left: var(--smrt-hairline);
    border-right: var(--smrt-hairline);
    box-shadow: -24px 0 40px
      color-mix(in srgb, var(--smrt-color-shadow) 18%, transparent);
    transition:
      transform 180ms cubic-bezier(0.2, 0, 0, 1),
      opacity 120ms ease;
  }
  .smrt-tools-dock__panel-header h3 {
    font-size: var(--smrt-typography-title-medium-size, 1.05rem);
    line-height: var(--smrt-typography-title-medium-line-height, 1.15);
  }
  /* The close control now renders through smrt-ui <Button>; pierce Svelte
  scoping into the child-rendered <button> with `:global` (#1589). */
  .smrt-tools-dock__panel-header :global(.smrt-tools-dock__close) {
    border: var(--smrt-hairline);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-high);
    color: inherit;
    font-size: var(--smrt-typography-title-large-size, 1.2rem);
    line-height: 1;
  }
  .smrt-tools-dock__empty {
    color: var(--smrt-color-on-surface-variant);
    text-align: center;
  }
  .smrt-tools-dock__empty strong {
    color: var(--smrt-color-on-surface);
  }
  .smrt-tools-dock__empty p {
    line-height: 1.45;
  }
  .smrt-tools-dock__topbar-button {
    border: var(--smrt-hairline);
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
    border-radius: 0.6rem;
    font-size: var(--smrt-typography-label-large-size, 0.84rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-tools-dock__topbar-button.smrt-tools-dock__active,
  .smrt-tools-dock__topbar-button:hover {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
  }
  /* Leading glyph in the topbar layout. Sized to match the surrounding
  text — consumers wanting a different size can wrap their icon
  component to hard-code dimensions (see ToolDef.iconComponent docs). */
  .smrt-tools-dock__topbar-button-icon {
    line-height: 1;
    font-size: var(--smrt-typography-body-large-size, 0.95rem);
  }
  .smrt-tools-dock__topbar-mode .smrt-tools-dock__panel {
    border-radius: 0.75rem;
  }
  /* ---------- A11y helpers ---------- */
  .smrt-tools-dock__sr-only {
    border: 0;
  }
  /* ---------- Mobile (drawer) ---------- */
  @media (max-width: 960px) {
    .smrt-tools-dock__overlay {
      border: 0;
      background: var(--smrt-color-scrim);
    }
  }
}
</style>
