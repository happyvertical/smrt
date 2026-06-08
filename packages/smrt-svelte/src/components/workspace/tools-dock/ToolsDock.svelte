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
  import type { ToolsDockContext } from '../types.js';
  import type { ToolsDockInstance } from './define-tools-dock.svelte.js';

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
  <button
    type="button"
    class:active={isActive}
    class={variant === 'rail' ? 'tools-dock__rail-button' : 'tools-dock__topbar-button'}
    aria-pressed={isActive}
    aria-label={`${label} tool`}
    title={label}
    onclick={(event) => handleButtonClick(event, tool.id)}
  >
    {#if variant === 'topbar'}
      {#if IconComponent}
        <span class="tools-dock__topbar-button-icon" aria-hidden="true">
          <IconComponent />
        </span>
      {:else if iconString}
        <span class="tools-dock__topbar-button-icon" aria-hidden="true">
          {iconString}
        </span>
      {/if}
      <span class="tools-dock__topbar-button-label">{label}</span>
    {:else}
      <span class="tools-dock__rail-glyph" aria-hidden="true">
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
      <span class="tools-dock__badge">{tool.badge}</span>
    {/if}
  </button>
{/snippet}

{#snippet panel()}
  {@const ActiveTool = activeToolDef()?.component}
  <div
    class="tools-dock__panel"
    class:tools-dock__panel--open={dock.isOpen}
    role="dialog"
    aria-label={dock.activeTool ? `${labelFor(dock.activeTool)} tool panel` : 'Tools panel'}
    aria-modal="false"
    aria-hidden={!dock.isOpen}
    inert={!dock.isOpen}
  >
    <header class="tools-dock__panel-header">
      <h3>{dock.activeTool ? labelFor(dock.activeTool) : 'Tools'}</h3>
      <button
        type="button"
        class="tools-dock__close"
        onclick={handleClose}
        aria-label={closeLabel}
        title={closeLabel}
      >
        ×
      </button>
    </header>

    <div class="tools-dock__panel-body">
      {#if dock.availableTools.length === 0}
        <div class="tools-dock__empty">
          <strong>No tools available</strong>
          <p>No tools are available for the current context.</p>
        </div>
      {:else if ActiveTool}
        <ActiveTool context={dock.context} {dock} />
      {:else}
        <div class="tools-dock__empty">
          <p>Select a tool to begin.</p>
        </div>
      {/if}
    </div>
  </div>
{/snippet}

<!-- Polite live region announces tool transitions for screen readers. -->
<div class="tools-dock__sr-only" role="status" aria-live="polite">{announcement}</div>

{#if dock.layout === 'topbar'}
  <div class="tools-dock tools-dock--topbar">
    <nav class="tools-dock__topbar" aria-label="Workspace tools">
      {#each dock.availableTools as tool (tool.id)}
        {@render toolButton(tool, 'topbar')}
      {/each}
    </nav>
    {#if dock.isOpen}
      {@render panel()}
    {/if}
  </div>
{:else}
  <aside class="tools-dock tools-dock--rail" class:tools-dock--open={dock.isOpen}>
    {#if dock.isOpen}
      <button
        type="button"
        class="tools-dock__overlay"
        aria-label={closeLabel}
        onclick={handleClose}
      ></button>
    {/if}
    {@render panel()}
    <nav class="tools-dock__rail" aria-label="Workspace tools">
      {#each dock.availableTools as tool (tool.id)}
        {@render toolButton(tool, 'rail')}
      {/each}
    </nav>
  </aside>
{/if}

<style>
  .tools-dock {
    --tools-dock-rail-width: 3.25rem;
    --tools-dock-panel-width: 420px;
    color: var(--smrt-color-on-surface, #f8fafc);
    box-sizing: border-box;
  }

  /* ---------- Rail layout ---------- */

  .tools-dock--rail {
    position: sticky;
    top: 0;
    align-self: flex-start;
    z-index: 20;
    height: 100vh;
    width: var(--tools-dock-rail-width);
    flex: 0 0 var(--tools-dock-rail-width);
    display: block;
  }

  .tools-dock__rail {
    position: relative;
    z-index: 2;
    width: var(--tools-dock-rail-width);
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 0.6rem 0.45rem;
    background: var(--smrt-color-surface-container-low, #11161b);
    border-left: 1px solid var(--smrt-color-outline-variant, #30343a);
  }

  .tools-dock__rail-button {
    position: relative;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    display: inline-grid;
    place-items: center;
    border: 1px solid transparent;
    border-radius: 0.45rem;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #aab2bd);
    cursor: pointer;
  }

  .tools-dock__rail-button:hover,
  .tools-dock__rail-button.active {
    background: var(--smrt-color-surface-container-high, #1d2228);
    color: var(--smrt-color-on-surface, #f8fafc);
  }

  .tools-dock__rail-button:focus-visible,
  .tools-dock__topbar-button:focus-visible,
  .tools-dock__close:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #7dd3fc);
    outline-offset: 2px;
  }

  .tools-dock__rail-glyph {
    font-size: 0.95rem;
    font-weight: 700;
    line-height: 1;
  }

  .tools-dock__badge {
    position: absolute;
    top: 0.18rem;
    right: 0.12rem;
    min-width: 0.85rem;
    height: 0.85rem;
    padding: 0 0.18rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: var(--smrt-color-primary, #7dd3fc);
    color: var(--smrt-color-on-primary, #061014);
    font-size: 0.58rem;
    font-weight: 750;
    line-height: 1;
  }

  /* ---------- Panel ---------- */

  .tools-dock__panel {
    position: absolute;
    inset: 0 var(--tools-dock-rail-width) 0 auto;
    height: 100%;
    width: var(--tools-dock-panel-width);
    min-width: var(--tools-dock-panel-width);
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 1rem;
    background: var(--smrt-color-surface, #101214);
    color: var(--smrt-color-on-surface, #f8fafc);
    overflow: hidden;
    border-left: 1px solid var(--smrt-color-outline-variant, #30343a);
    border-right: 1px solid var(--smrt-color-outline-variant, #30343a);
    box-shadow: -24px 0 40px
      color-mix(in srgb, var(--smrt-color-shadow) 18%, transparent);
    transform: translateX(calc(100% + var(--tools-dock-rail-width)));
    opacity: 0;
    pointer-events: none;
    transition:
      transform 180ms cubic-bezier(0.2, 0, 0, 1),
      opacity 120ms ease;
    will-change: transform;
    contain: layout paint style;
  }

  .tools-dock--rail.tools-dock--open .tools-dock__panel,
  .tools-dock__panel--open {
    transform: translateX(0);
    opacity: 1;
    pointer-events: auto;
  }

  .tools-dock__panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .tools-dock__panel-header h3 {
    margin: 0;
    font-size: 1.05rem;
    line-height: 1.15;
  }

  .tools-dock__panel-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  .tools-dock__close {
    width: 2rem;
    height: 2rem;
    display: inline-grid;
    place-items: center;
    border: 1px solid var(--smrt-color-outline-variant, #30343a);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-high, #1d2228);
    color: inherit;
    cursor: pointer;
    font-size: 1.2rem;
    line-height: 1;
  }

  .tools-dock__empty {
    display: grid;
    align-content: center;
    gap: 0.45rem;
    min-height: 12rem;
    padding: 1rem;
    color: var(--smrt-color-on-surface-variant, #aab2bd);
    text-align: center;
  }

  .tools-dock__empty strong {
    color: var(--smrt-color-on-surface, #f8fafc);
  }

  .tools-dock__empty p {
    margin: 0;
    line-height: 1.45;
  }

  .tools-dock__overlay {
    display: none;
  }

  /* ---------- Topbar layout ---------- */

  .tools-dock--topbar {
    display: contents;
  }

  .tools-dock__topbar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .tools-dock__topbar-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    border: 1px solid var(--smrt-color-outline-variant, #30343a);
    background: var(--smrt-color-surface-container-low, #11161b);
    color: var(--smrt-color-on-surface-variant, #aab2bd);
    border-radius: 0.6rem;
    padding: 0.45rem 0.7rem;
    cursor: pointer;
    font-size: 0.84rem;
    font-weight: 600;
  }

  .tools-dock__topbar-button.active,
  .tools-dock__topbar-button:hover {
    background: var(--smrt-color-surface-container-high, #1d2228);
    color: var(--smrt-color-on-surface, #f8fafc);
  }

  /* Leading glyph in the topbar layout. Sized to match the surrounding
     text — consumers wanting a different size can wrap their icon
     component to hard-code dimensions (see ToolDef.iconComponent docs). */
  .tools-dock__topbar-button-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    font-size: 0.95rem;
  }

  .tools-dock--topbar .tools-dock__panel {
    position: fixed;
    inset: auto 1rem 1rem auto;
    height: min(70vh, 600px);
    border-radius: 0.75rem;
    z-index: 40;
  }

  /* ---------- A11y helpers ---------- */

  .tools-dock__sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* ---------- Mobile (drawer) ---------- */

  @media (max-width: 960px) {
    .tools-dock__overlay {
      display: block;
      position: fixed;
      inset: 0;
      z-index: var(--smrt-z-index-overlay, 1200);
      padding: 0;
      border: 0;
      background: var(--smrt-color-scrim);
      cursor: default;
    }

    .tools-dock--rail {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: var(--tools-dock-rail-width);
      height: 100vh;
      height: 100dvh;
      z-index: var(--smrt-z-index-modal, 1300);
      --tools-dock-panel-width: min(420px, calc(100vw - var(--tools-dock-rail-width)));
    }

    /* Mobile: keep panel and rail above the close overlay so taps reach the
       tool UI. The overlay sits at z-index 65 and previously rendered above
       the panel (no z-index) and rail (z-index: 2) within the same stacking
       context — every tap hit the close button instead of the tool. */
    .tools-dock__panel {
      z-index: var(--smrt-z-index-modal, 1300);
    }

    .tools-dock__rail {
      z-index: var(--smrt-z-index-modal, 1300);
    }
  }

  @media (max-width: 640px) {
    .tools-dock--rail {
      --tools-dock-panel-width: calc(100vw - var(--tools-dock-rail-width));
    }

    .tools-dock__panel {
      padding: 0.85rem;
    }
  }
</style>
