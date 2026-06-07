<script lang="ts">
import type { Snippet } from 'svelte';

/**
 * WorkspaceShell — SvelteKit-agnostic, SSR-safe admin shell primitive.
 *
 * A composition of snippet slots that lays out a typical workspace UI: brand
 * + nav sidebar, sticky topbar, main content, optional right-side inspector
 * panel and a thin icon rail. The component owns no domain logic — every
 * visible region (brand, nav, account menu, tools dock, etc.) is provided by
 * the consumer via Svelte 5 snippets.
 *
 * Responsive behavior:
 * - Desktop (>1240px): sidebar visible, inspector fixed-right when open.
 * - Tablet (961–1240px): sidebar collapses to icon rail.
 * - Mobile (≤960px): sidebar becomes a drawer with backdrop; inspector
 *   becomes a right-side drawer with backdrop.
 *
 * Sidebar collapse is controlled — consumer owns persistence. Mobile drawer
 * state defaults to internal/transient but can be lifted via the bindable
 * `mobileNavOpen` prop (see below) for consumers that need to close the
 * drawer in response to events the shell doesn't own (e.g. a route change
 * fired from a nav-tree click). Pair `bind:mobileNavOpen={...}` on the
 * shell with `<NavTree onNavigate={() => (mobileNavOpen = false)} />`
 * inside the `nav` snippet to close the drawer on every link click —
 * no DOM querying required.
 *
 * See `@happyvertical/smrt#1227` for the issue tracking this primitive,
 * and `happyvertical/smrt#1235` for the bindable-drawer follow-up.
 */

export interface Props {
  /** Brand/product title shown in the brand snippet area fallback. */
  title?: string;
  /** Secondary line under the title. */
  subtitle?: string;
  /** Small uppercase eyebrow label rendered above the title. */
  eyebrow?: string;
  /** Topbar mode label (e.g. "Local-first mode"). */
  modeLabel?: string;
  /** Status keyword that maps to a dot color. */
  modeStatus?:
    | 'active'
    | 'offline'
    | 'local-only'
    | 'attention'
    | (string & {});
  /** Secondary detail line shown next to the mode badge. */
  modeDetail?: string;
  /** Whether the inspector panel/drawer is currently shown. */
  showInspector?: boolean;
  /**
   * Label rendered in the inspector header. Defaults to `'Inspector'`.
   * Consumers may rename to `'Properties'`, `'Details'`, etc.
   */
  inspectorTitle?: string;
  /**
   * Invoked when the inspector close button (or Escape) is activated.
   *
   * Focus restoration: because `showInspector` is a controlled prop, the
   * consumer owns when the inspector opens and is therefore responsible
   * for restoring focus to the activating element after close (WCAG
   * 2.4.3). A common pattern is to capture `document.activeElement`
   * immediately before flipping `showInspector` to `true`, then call
   * `.focus()` on it inside this handler.
   *
   * The component-owned mobile drawer handles focus restoration
   * internally — only the inspector is consumer-driven.
   */
  onCloseInspector?: () => void;
  /** Sidebar collapsed state (controlled by consumer). */
  collapsed?: boolean;
  /** Invoked when the internal collapse toggle is clicked. */
  onToggleCollapsed?: () => void;
  /** Whether to render the collapse toggle at all. Default: true. */
  collapsible?: boolean;
  /** Top-left brand area (logo + product name). */
  brand?: Snippet;
  /** Main sidebar navigation region. */
  nav?: Snippet;
  /** Bottom of sidebar (account menu, tenant switcher, etc.). */
  sidebarFooter?: Snippet;
  /** Right side of the top bar. */
  topbarActions?: Snippet;
  /** Optional vertical icon rail along the right edge. */
  inspectorRail?: Snippet;
  /**
   * Inspector panel content (right side). Rendered into a `position: fixed`
   * panel anchored to the right edge — z-index `22` on desktop, `22` on
   * mobile (with a `21` scrim).
   *
   * **Positioning conflict**: do NOT use this snippet simultaneously with
   * `<ToolsDock layout='topbar'>`. In topbar mode, the dock owns its own
   * `position: fixed` panel anchored to the bottom-right (z-index `40`)
   * with no z-index coordination against the shell's inspector — both
   * panels will visibly overlap and compete for clicks. Pick one:
   *   - For consumer-driven inspector content → use this snippet only,
   *     and use `<ToolsDock layout='rail'>` (the rail layout renders its
   *     panel inside its own aside, no positioning conflict)
   *   - For tools-dock-driven content → leave this snippet unused and
   *     render `<ToolsDock layout='topbar'>` inside `topbarActions`
   */
  inspector?: Snippet;
  /** Main content. */
  children: Snippet;
  /**
   * Mobile drawer open-state. Defaults to `false` and is managed
   * internally — the hamburger button, backdrop, and Escape key all
   * toggle it. Consumers who need to close the drawer in response to
   * events outside the shell (e.g. a nav-link click in their nav
   * snippet) can lift the state via `bind:mobileNavOpen={...}` and
   * mutate it directly. SSR-safe — initial value is honored on the
   * server (the drawer is only visible on the ≤960px breakpoint).
   */
  mobileNavOpen?: boolean;
}

let {
  title = '',
  subtitle = '',
  eyebrow = '',
  modeLabel = '',
  modeStatus = '',
  modeDetail = '',
  showInspector = false,
  inspectorTitle = 'Inspector',
  onCloseInspector,
  collapsed = false,
  onToggleCollapsed,
  collapsible = true,
  brand,
  nav,
  sidebarFooter,
  topbarActions,
  inspectorRail,
  inspector,
  children,
  mobileNavOpen = $bindable(false),
}: Props = $props();

/**
 * Tracks whether the viewport is in the mobile drawer breakpoint
 * (≤960px). Used to mark the sidebar `inert` when it's slid off-screen
 * so keyboard users can't tab into invisible nav links. SSR-safe — stays
 * `false` until mounted, which matches the desktop-first default layout.
 */
let isMobileViewport = $state(false);
/**
 * Element that held focus when the mobile drawer was opened. We restore
 * focus to it when the drawer closes (Escape, backdrop click, etc.) to
 * satisfy WCAG 2.4.3 Focus Order for the component-owned drawer state.
 * The inspector's open state is consumer-controlled, so focus restoration
 * for it is documented as a caller responsibility (see `onCloseInspector`).
 */
let lastFocusedBeforeMobileNav: HTMLElement | null = null;

function toggleMobileNav(): void {
  if (!mobileNavOpen) {
    // Capture the currently focused element before we open the drawer so
    // we can return focus to it on close (WCAG 2.4.3).
    if (typeof document !== 'undefined') {
      const active = document.activeElement;
      lastFocusedBeforeMobileNav =
        active instanceof HTMLElement ? active : null;
    }
    mobileNavOpen = true;
  } else {
    closeMobileNav();
  }
}

function closeMobileNav(): void {
  mobileNavOpen = false;
  // Restore focus to the element that opened the drawer (the hamburger
  // button in the default flow). Guarded so SSR/non-DOM environments are
  // a no-op, and so a detached/removed element doesn't throw.
  const target = lastFocusedBeforeMobileNav;
  lastFocusedBeforeMobileNav = null;
  if (
    target &&
    typeof document !== 'undefined' &&
    document.contains(target) &&
    typeof target.focus === 'function'
  ) {
    target.focus();
  }
}

function handleCollapseToggle(): void {
  onToggleCollapsed?.();
}

function handleInspectorClose(): void {
  onCloseInspector?.();
}

// Escape closes mobile drawer (with focus restoration) or inspector if
// open. Mounted-only (SSR-safe via $effect).
$effect(() => {
  if (typeof window === 'undefined') return;

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    if (mobileNavOpen) {
      closeMobileNav();
      return;
    }
    if (showInspector && onCloseInspector) {
      onCloseInspector();
    }
  }

  window.addEventListener('keydown', onKeydown);
  return () => window.removeEventListener('keydown', onKeydown);
});

// Track mobile breakpoint so the sidebar can be marked `inert` while it
// is slid off-screen. Mirrors the `@media (max-width: 960px)` block.
$effect(() => {
  if (typeof window === 'undefined' || !window.matchMedia) return;

  const mql = window.matchMedia('(max-width: 960px)');
  isMobileViewport = mql.matches;

  function handleChange(event: MediaQueryListEvent) {
    isMobileViewport = event.matches;
  }

  // `addEventListener` is the modern API. Older Safari only has
  // `addListener` — feature-detect to stay compatible. The deprecated
  // `addListener`/`removeListener` methods are typed in current lib.dom.d.ts,
  // so no `@ts-expect-error` is needed.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }
  mql.addListener(handleChange);
  return () => {
    mql.removeListener(handleChange);
  };
});

const hasInspector = $derived(Boolean(inspector) && showInspector);
const hasInspectorRail = $derived(Boolean(inspectorRail));
/**
 * Mark the sidebar `inert` when it's slid off-screen on mobile so keyboard
 * users can't tab into invisible nav links / footer controls.
 */
const sidebarInert = $derived(isMobileViewport && !mobileNavOpen);
</script>

<div
  class="smrt-workspace-shell"
  class:sidebar-collapsed={collapsed}
  class:nav-open={mobileNavOpen}
  class:has-inspector={hasInspector}
  class:has-inspector-rail={hasInspectorRail}
>
  <!-- Mobile sidebar backdrop -->
  <button
    class="mobile-backdrop"
    type="button"
    aria-label="Close navigation"
    tabindex={mobileNavOpen ? 0 : -1}
    onclick={closeMobileNav}
  ></button>

  <!--
    Mobile inspector backdrop. Only renders an interactive button when the
    consumer provided `onCloseInspector` — otherwise the backdrop would be a
    focusable no-op. When no close handler is provided we render a passive
    `<div>` so the visual scrim still appears on mobile.
  -->
  {#if hasInspector}
    {#if onCloseInspector}
      <button
        class="inspector-backdrop"
        type="button"
        aria-label="Close inspector"
        onclick={handleInspectorClose}
      ></button>
    {:else}
      <div class="inspector-backdrop" aria-hidden="true"></div>
    {/if}
  {/if}

  <aside
    class="smrt-workspace-sidebar"
    aria-label="Primary navigation"
    inert={sidebarInert}
  >
    <div class="brand-row">
      <div class="brand">
        {#if brand}
          {@render brand()}
        {:else}
          {#if eyebrow}
            <span class="eyebrow">{eyebrow}</span>
          {/if}
          {#if title}
            <h1>{title}</h1>
          {/if}
          {#if subtitle}
            <p class="subtitle">{subtitle}</p>
          {/if}
        {/if}
      </div>

      {#if collapsible && onToggleCollapsed}
        <button
          class="shell-toggle"
          type="button"
          onclick={handleCollapseToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          <span class="shell-toggle-glyph" aria-hidden="true">
            {collapsed ? '›' : '‹'}
          </span>
        </button>
      {/if}
    </div>

    {#if nav}
      <nav class="nav-region" aria-label="Workspace navigation">
        {@render nav()}
      </nav>
    {/if}

    {#if sidebarFooter}
      <div class="sidebar-footer">
        {@render sidebarFooter()}
      </div>
    {/if}
  </aside>

  <div class="smrt-workspace-main">
    <header class="smrt-workspace-topbar">
      <div class="topbar-left">
        <button
          class="mobile-menu"
          type="button"
          onclick={toggleMobileNav}
          aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileNavOpen}
        >
          <span aria-hidden="true">≡</span>
        </button>
        <div class="topbar-brand">
          {#if eyebrow}
            <div class="eyebrow topbar-eyebrow">{eyebrow}</div>
          {/if}
          {#if modeLabel}
            <p class="mode-title">{modeLabel}</p>
          {/if}
        </div>
      </div>

      <div class="topbar-right">
        {#if topbarActions}
          <div class="topbar-actions">
            {@render topbarActions()}
          </div>
        {/if}
        {#if modeLabel || modeStatus}
          <span
            class="mode-badge"
            data-status={modeStatus || 'default'}
            role="status"
            aria-live="polite"
          >
            <span class="mode-dot" aria-hidden="true"></span>
            <span class="mode-badge-label">{modeLabel || modeStatus}</span>
          </span>
        {/if}
        {#if modeDetail}
          <p class="mode-detail">{modeDetail}</p>
        {/if}
      </div>
    </header>

    <div class="smrt-workspace-stage">
      <main class="smrt-workspace-content">
        {@render children()}
      </main>

      {#if hasInspector}
        <aside
          class="smrt-workspace-inspector"
          aria-label={inspectorTitle}
        >
          <div class="inspector-header">
            <span class="inspector-title">{inspectorTitle}</span>
            {#if onCloseInspector}
              <button
                class="inspector-close"
                type="button"
                onclick={handleInspectorClose}
                aria-label="Close inspector"
              >
                <span aria-hidden="true">×</span>
              </button>
            {/if}
          </div>
          <div class="inspector-body">
            {@render inspector!()}
          </div>
        </aside>
      {/if}

      {#if hasInspectorRail}
        <div
          class="smrt-workspace-inspector-rail"
          role="toolbar"
          aria-label="Inspector tools"
          aria-orientation="vertical"
        >
          {@render inspectorRail!()}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .smrt-workspace-shell {
    --smrt-ws-sidebar-width: 280px;
    --smrt-ws-sidebar-collapsed-width: 96px;
    --smrt-ws-inspector-width: min(420px, calc(100vw - var(--smrt-ws-sidebar-width) - 1rem));
    --smrt-ws-rail-width: 3.25rem;
    --smrt-ws-topbar-height: 3.75rem;
    --smrt-ws-page-pad: 1.5rem;

    position: relative;
    display: grid;
    grid-template-columns: var(--smrt-ws-sidebar-width) 1fr;
    min-height: 100vh;
    min-height: 100dvh;
    background: var(--smrt-color-surface-container-low, #f8fafc);
    color: var(--smrt-color-on-surface, #1f2937);
    isolation: isolate;
  }

  .smrt-workspace-shell.sidebar-collapsed {
    grid-template-columns: var(--smrt-ws-sidebar-collapsed-width) 1fr;
    /*
     * When the sidebar is collapsed, recompute the inspector-width clamp
     * against the collapsed sidebar so narrower desktops with both the
     * inspector and a collapsed sidebar still fit content. Without this
     * override, padding-right on `.smrt-workspace-content` would still be
     * sized as if the sidebar were full-width.
     */
    --smrt-ws-inspector-width: min(
      420px,
      calc(100vw - var(--smrt-ws-sidebar-collapsed-width) - 1rem)
    );
  }

  /* ─── Sidebar ─────────────────────────────────────────── */

  .smrt-workspace-sidebar {
    position: sticky;
    top: 0;
    align-self: start;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1.25rem 1rem;
    height: 100vh;
    height: 100dvh;
    box-sizing: border-box;
    background: var(--smrt-color-surface, #ffffff);
    border-right: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    min-width: 0;
    overflow: hidden;
    overscroll-behavior: contain;
    z-index: 20;
  }

  .brand-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .brand {
    display: grid;
    gap: 0.35rem;
    min-width: 0;
  }

  .brand :global(h1),
  .brand h1 {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.1;
    color: var(--smrt-color-on-surface, #111827);
    font-weight: 600;
  }

  .brand .subtitle {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    line-height: 1.4;
    font-size: 0.9rem;
  }

  .eyebrow {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .shell-toggle {
    appearance: none;
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    background: var(--smrt-color-surface-container, #f3f4f6);
    color: var(--smrt-color-on-surface, #111827);
    border-radius: var(--smrt-radius-medium, 0.65rem);
    width: 2rem;
    height: 2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    transition:
      background-color 150ms ease,
      color 150ms ease;
  }

  .shell-toggle:hover {
    background: var(--smrt-color-surface-container-high, #e5e7eb);
  }

  .shell-toggle:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #2563eb);
    outline-offset: 2px;
  }

  .shell-toggle-glyph {
    font-size: 1rem;
    line-height: 1;
  }

  .nav-region {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    gap: 0.5rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .sidebar-footer {
    margin-top: auto;
    flex: 0 0 auto;
    display: grid;
    gap: 0.75rem;
    padding-top: 0.75rem;
    background: var(--smrt-color-surface, #ffffff);
    border-top: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    z-index: 1;
  }

  /* ─── Main column ─────────────────────────────────────── */

  .smrt-workspace-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .smrt-workspace-topbar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.85rem;
    padding: 0.75rem var(--smrt-ws-page-pad);
    min-height: var(--smrt-ws-topbar-height);
    background: var(--smrt-color-surface, #ffffff);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    box-shadow: var(--smrt-elevation-1, 0 1px 2px rgb(0 0 0 / 0.05));
  }

  .topbar-left,
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    min-width: 0;
  }

  .topbar-right {
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .topbar-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .topbar-brand {
    display: grid;
    gap: 0.1rem;
    min-width: 0;
  }

  .topbar-eyebrow {
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .mode-title,
  .mode-detail {
    margin: 0;
  }

  .mode-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--smrt-color-on-surface, #111827);
  }

  .mode-detail {
    color: var(--smrt-color-on-surface-variant, #6b7280);
    max-width: 18rem;
    text-align: right;
    font-size: 0.85rem;
  }

  .mode-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.65rem;
    border-radius: var(--smrt-radius-full, 999px);
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    background: var(--smrt-color-surface-container, #f3f4f6);
    color: var(--smrt-color-on-surface, #111827);
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
  }

  .mode-dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 999px;
    background: var(--smrt-color-on-surface-variant, #9ca3af);
    flex-shrink: 0;
  }

  .mode-badge[data-status='active'] .mode-dot {
    background: var(--smrt-color-success, #16a34a);
  }
  .mode-badge[data-status='offline'] .mode-dot {
    background: var(--smrt-color-on-surface-variant, #9ca3af);
  }
  .mode-badge[data-status='local-only'] .mode-dot {
    background: var(--smrt-color-primary, #2563eb);
  }
  .mode-badge[data-status='attention'] .mode-dot {
    background: var(--smrt-color-warning, #f59e0b);
  }

  .mobile-menu {
    display: none;
    appearance: none;
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    background: var(--smrt-color-surface, #ffffff);
    color: var(--smrt-color-on-surface, #111827);
    border-radius: var(--smrt-radius-medium, 0.65rem);
    width: 2.35rem;
    height: 2.35rem;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
  }

  .mobile-menu:focus-visible,
  .inspector-close:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #2563eb);
    outline-offset: 2px;
  }

  /* ─── Stage / content / inspector ─────────────────────── */

  .smrt-workspace-stage {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .smrt-workspace-content {
    padding: var(--smrt-ws-page-pad);
    min-width: 0;
  }

  .smrt-workspace-inspector {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--smrt-ws-inspector-width);
    display: flex;
    flex-direction: column;
    background: var(--smrt-color-surface, #ffffff);
    border-left: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    box-shadow: var(--smrt-elevation-2, 0 4px 6px -1px rgb(0 0 0 / 0.1));
    z-index: 22;
  }

  .inspector-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
  }

  .inspector-title {
    font-weight: 600;
    color: var(--smrt-color-on-surface, #111827);
    font-size: 0.95rem;
  }

  .inspector-close {
    appearance: none;
    border: 1px solid transparent;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    width: 2rem;
    height: 2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    line-height: 1;
    cursor: pointer;
    transition:
      background-color 150ms ease,
      color 150ms ease;
  }

  .inspector-close:hover {
    background: var(--smrt-color-surface-container-high, #e5e7eb);
    color: var(--smrt-color-on-surface, #111827);
  }

  .inspector-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem;
  }

  .smrt-workspace-inspector-rail {
    position: fixed;
    top: var(--smrt-ws-topbar-height);
    right: 0;
    bottom: 0;
    width: var(--smrt-ws-rail-width);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
    padding: 0.75rem 0.25rem;
    background: var(--smrt-color-surface, #ffffff);
    border-left: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    z-index: 18;
  }

  /* When both inspector + rail are present, push rail off the panel. */
  .smrt-workspace-shell.has-inspector.has-inspector-rail .smrt-workspace-inspector-rail {
    right: var(--smrt-ws-inspector-width);
  }

  /* Reserve room on the right side so content doesn't slide under panel/rail. */
  @media (min-width: 961px) {
    .smrt-workspace-shell.has-inspector .smrt-workspace-content,
    .smrt-workspace-shell.has-inspector .smrt-workspace-topbar {
      padding-right: calc(var(--smrt-ws-inspector-width) + 1rem);
    }

    .smrt-workspace-shell.has-inspector-rail:not(.has-inspector)
      .smrt-workspace-content,
    .smrt-workspace-shell.has-inspector-rail:not(.has-inspector)
      .smrt-workspace-topbar {
      padding-right: calc(var(--smrt-ws-rail-width) + 1rem);
    }

    /*
     * When both the inspector panel AND the icon rail are present, the rail
     * sits to the left of the panel (see `.has-inspector.has-inspector-rail
     * .smrt-workspace-inspector-rail` above). Content padding must reserve
     * room for both, otherwise the rail overlaps the right edge of content
     * and topbar.
     */
    .smrt-workspace-shell.has-inspector.has-inspector-rail
      .smrt-workspace-content,
    .smrt-workspace-shell.has-inspector.has-inspector-rail
      .smrt-workspace-topbar {
      padding-right: calc(
        var(--smrt-ws-inspector-width) + var(--smrt-ws-rail-width) + 1rem
      );
    }
  }

  /* ─── Backdrops (mobile only — hidden otherwise) ──────── */

  /*
   * Defence-in-depth: `display: none` already hides these on desktop, but a
   * consumer global like `button { display: flex }` could undo that. Setting
   * `pointer-events: none` ensures the backdrop can never intercept clicks
   * on the desktop even if it slips back into the rendering tree.
   */
  .mobile-backdrop,
  .inspector-backdrop {
    display: none;
    pointer-events: none;
  }

  /* ─── Tablet — collapse sidebar to icon rail ──────────── */

  @media (max-width: 1240px) and (min-width: 961px) {
    .smrt-workspace-shell {
      grid-template-columns: var(--smrt-ws-sidebar-collapsed-width) 1fr;
    }

    .smrt-workspace-shell .brand-row {
      justify-content: center;
    }

    .smrt-workspace-shell .shell-toggle {
      display: none;
    }

    .smrt-workspace-shell .brand .subtitle,
    .smrt-workspace-shell.sidebar-collapsed .brand .subtitle {
      display: none;
    }
  }

  /* ─── Mobile — drawer sidebar, drawer inspector ───────── */

  @media (max-width: 960px) {
    .smrt-workspace-shell,
    .smrt-workspace-shell.sidebar-collapsed {
      grid-template-columns: 1fr;
    }

    .mobile-menu {
      display: inline-flex;
    }

    .shell-toggle {
      display: none;
    }

    .smrt-workspace-sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      width: min(320px, calc(100vw - 3rem));
      transform: translateX(-100%);
      transition: transform 180ms ease;
      z-index: 30;
    }

    .smrt-workspace-shell.nav-open .smrt-workspace-sidebar {
      transform: translateX(0);
    }

    .mobile-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: var(--smrt-color-scrim);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease;
      border: 0;
      z-index: 25;
    }

    .smrt-workspace-shell.nav-open .mobile-backdrop {
      opacity: 1;
      pointer-events: auto;
    }

    /* Override the inspector-width variable on mobile so the rail's right
     * offset (.has-inspector.has-inspector-rail .smrt-workspace-inspector-rail
     * uses var(--smrt-ws-inspector-width) for `right`) stays in sync with
     * the actual rendered inspector width. */
    .smrt-workspace-shell {
      --smrt-ws-inspector-width: min(100vw, 420px);
    }

    .smrt-workspace-shell.has-inspector .smrt-workspace-inspector-rail,
    .smrt-workspace-shell.has-inspector-rail:not(.has-inspector)
      .smrt-workspace-inspector-rail {
      top: 0;
    }

    .smrt-workspace-shell.has-inspector .smrt-workspace-content,
    .smrt-workspace-shell.has-inspector .smrt-workspace-topbar {
      padding-right: var(--smrt-ws-page-pad);
    }

    .smrt-workspace-shell.has-inspector-rail:not(.has-inspector)
      .smrt-workspace-content,
    .smrt-workspace-shell.has-inspector-rail:not(.has-inspector)
      .smrt-workspace-topbar {
      padding-right: calc(var(--smrt-ws-rail-width) + var(--smrt-ws-page-pad));
    }

    .inspector-backdrop {
      display: block;
      pointer-events: auto;
      position: fixed;
      inset: 0;
      background: var(--smrt-color-scrim);
      border: 0;
      z-index: 21;
    }

    .mode-detail {
      max-width: 100%;
      text-align: left;
    }
  }
</style>
