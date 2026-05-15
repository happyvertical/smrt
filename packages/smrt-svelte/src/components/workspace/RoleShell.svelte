<script lang="ts">
/**
 * RoleShell — opinionated thin wrapper around `WorkspaceShell`, `NavTree`,
 * and `Breadcrumbs` for multi-role admin dashboards.
 *
 * Lifts the `RoleConfig`-driven render pattern that's been duplicated in
 * downstream apps (notably anytown.ai's dashboard) into the framework. Pass
 * a list of `RoleConfig`s + the currently active role id; the shell looks
 * up the role and wires its sections into the sidebar nav and breadcrumb
 * trail. Optional `color` on the role propagates as a `--smrt-role-color`
 * CSS custom property so consumer CSS can theme child components.
 *
 * Pure render layer — no SmrtObject coupling, no manifest access, no
 * SvelteKit imports. Consumers pass `currentPath` explicitly (typically
 * from `page.url.pathname`).
 *
 * **Missing-role behaviour**: in development a thrown error makes the
 * misconfiguration loud and immediate. In production we fall back to the
 * first role in `roles[]` (or, if `roles[]` is empty, a synthetic empty
 * role) so a brief mismatch — role-switch race, SSR hydration with stale
 * data, an empty array before data loads — degrades to a harmless empty
 * shell instead of crashing the component tree. Svelte 5 has no built-in
 * error boundary, so a hard throw inside `$derived.by` would unmount the
 * whole shell. See `happyvertical/smrt#1238` review feedback.
 *
 * See `happyvertical/smrt#1226` (Phase 4b) for design notes. The
 * SmrtObject-aware piece was originally scoped here but has been
 * deferred — this primitive is intentionally cheap and low-blast-radius.
 */
import { DEV } from 'esm-env';
import type { Component, Snippet } from 'svelte';
import Breadcrumbs from './Breadcrumbs.svelte';
import NavTree from './NavTree.svelte';
import type { BreadcrumbItem, NavItem, RoleConfig } from './types.js';
import WorkspaceShell from './WorkspaceShell.svelte';

interface Props {
  /** All available roles. Looked up by `id`. */
  roles: RoleConfig[];
  /** Currently active role's id. The shell renders that role's config. */
  currentRole: string;
  /** Current pathname (consumer provides; SvelteKit-agnostic). */
  currentPath: string;
  /** Optional: override the shell title; defaults to the current role's label. */
  title?: string;
  /** Optional: override the shell subtitle; defaults to the current role's description. */
  subtitle?: string;
  /** Optional: small uppercase eyebrow label rendered above the title — passes through to `WorkspaceShell`. */
  eyebrow?: string;
  /** Optional: topbar mode label — passes through. */
  modeLabel?: string;
  /** Optional: topbar mode status — passes through. */
  modeStatus?:
    | 'active'
    | 'offline'
    | 'local-only'
    | 'attention'
    | (string & {});
  /** Optional: topbar mode detail — passes through. */
  modeDetail?: string;
  /** Optional: sidebar collapsed state — passes through to `WorkspaceShell`. */
  collapsed?: boolean;
  /** Optional: sidebar collapse handler — passes through to `WorkspaceShell`. */
  onToggleCollapsed?: () => void;
  /** Optional: whether the collapse toggle should render — passes through. */
  collapsible?: boolean;
  /** Optional: whether the inspector panel is currently shown — passes through. */
  showInspector?: boolean;
  /** Optional: inspector header label — passes through. */
  inspectorTitle?: string;
  /** Optional: inspector close handler — passes through. */
  onCloseInspector?: () => void;
  /** Optional: brand snippet — passes through to `WorkspaceShell`. When omitted, the default brand renders `role.icon` (if any) alongside the resolved title/subtitle. */
  brand?: Snippet;
  /** Optional: sidebar footer (account menu, tenant switcher) — passes through. */
  sidebarFooter?: Snippet;
  /** Optional: topbar actions — passes through. */
  topbarActions?: Snippet;
  /** Optional: inspector panel — passes through. Inspector content only renders when `showInspector` is also true. */
  inspector?: Snippet;
  /** Optional: inspector rail — passes through. */
  inspectorRail?: Snippet;
  /** Required: main content. */
  children: Snippet;
  /**
   * Mobile drawer open state — bindable via Svelte 5 `$bindable`. Pass as
   * `bind:mobileNavOpen={...}` to control externally (e.g. close the drawer
   * after a route change). Defaults to `false`.
   */
  mobileNavOpen?: boolean;
  /** Optional: show breadcrumbs (default: true). */
  showBreadcrumbs?: boolean;
  /**
   * Optional: override the breadcrumb's root crumb. Defaults to
   * `{ label: role.label, href: '/' + role.id }`. Set this when the shell
   * is mounted under a prefix (e.g. `/dashboard/[role]/...`,
   * `/t/:slug/admin`) so the root crumb points at a real route.
   */
  rootCrumb?: BreadcrumbItem;
  /**
   * Optional: pathname prefix to skip when auto-walking breadcrumbs.
   * Forwarded to `<Breadcrumbs startAfter={...}>`. Defaults to `role.id`
   * so a pathname like `/super/tenants` doesn't render a duplicate
   * `Super` crumb alongside the `rootCrumb`. Override when the shell is
   * mounted under a deeper prefix (e.g. `'dashboard/super'` for
   * `/dashboard/[role]/...`), or pass an empty string to opt out of the
   * default skip entirely.
   */
  breadcrumbStartAfter?: string;
  /**
   * Optional: icon renderer for `NavItem.icon` values, forwarded to the
   * inner `<NavTree>`. Pass an icon component (lucide-svelte etc.) when
   * your nav configs use icon *names* rather than emoji glyphs.
   */
  navIconComponent?: Component<{ name: string; size?: number }>;
  /**
   * Optional: extra side-effect to run after a nav link click. The shell
   * always closes the mobile drawer on navigation; this callback fires
   * after that internal close so consumers can layer in analytics,
   * router-store updates, etc. without losing the drawer behaviour.
   */
  onNavigate?: () => void;
}

let {
  roles,
  currentRole,
  currentPath,
  title,
  subtitle,
  eyebrow,
  modeLabel,
  modeStatus,
  modeDetail,
  collapsed,
  onToggleCollapsed,
  collapsible,
  showInspector,
  inspectorTitle,
  onCloseInspector,
  // Renamed locally so the snippet block below can declare `{#snippet brand()}`
  // without shadowing the prop (which would cause `{@render brand()}` to
  // recurse into the new snippet instead of the consumer-supplied one).
  brand: consumerBrand,
  sidebarFooter,
  topbarActions,
  inspector,
  inspectorRail,
  children,
  mobileNavOpen = $bindable(false),
  showBreadcrumbs = true,
  rootCrumb,
  breadcrumbStartAfter,
  navIconComponent,
  onNavigate,
}: Props = $props();

/**
 * Stable empty fallback used when `roles[]` is empty *and* we're in
 * production. Constructed once so identity comparisons stay stable across
 * derivations.
 */
const EMPTY_ROLE: RoleConfig = {
  id: '',
  label: '',
  sections: [] as NavItem[],
};

const role = $derived.by((): RoleConfig => {
  const found = roles.find((r) => r.id === currentRole);
  if (found) return found;
  // Dev: fail loud so misconfiguration is caught in test/dev. Prod: fall
  // back so a brief mismatch (role-switch race, SSR with stale data,
  // empty array before data loads) degrades to an empty shell rather
  // than crashing the entire component tree. Svelte 5 has no error
  // boundary, so a throw inside $derived.by would unmount the shell.
  if (DEV) {
    throw new Error(
      `[RoleShell] No role found for id "${currentRole}". ` +
        `Available role ids: ${roles.map((r) => r.id).join(', ') || '(none)'}.`,
    );
  }
  return roles[0] ?? EMPTY_ROLE;
});

const resolvedTitle = $derived(title ?? role.label);
const resolvedSubtitle = $derived(subtitle ?? role.description ?? '');
const resolvedRootCrumb = $derived(
  rootCrumb ?? { label: role.label, href: `/${role.id}` },
);
/**
 * Default the breadcrumb's `startAfter` skip-prefix to the role id when
 * the consumer doesn't supply one. Without this, the auto-walk on a
 * pathname like `/super/tenants` produces `Super Admin / Super /
 * Tenants` — the `rootCrumb` already represents the role, so the bare
 * `/super` segment becomes a duplicate fallback crumb. Skipping
 * through `role.id` collapses that.
 *
 * Consumers mounting the shell under a different prefix (e.g.
 * `/dashboard/[role]/...`) still need to pass an explicit
 * `breadcrumbStartAfter='dashboard/super'` — the default only covers
 * the simpler `/[role]/...` case. Passing an empty string opts out:
 * `??` preserves it because empty string is not nullish.
 */
const resolvedBreadcrumbStartAfter = $derived(breadcrumbStartAfter ?? role.id);
/**
 * Set the role-color CSS custom property on the shell wrapper when the
 * role config supplies one. Consumer stylesheets can read this via
 * `var(--smrt-role-color)` (e.g. to recolor active-nav highlights). When
 * omitted the wrapper renders no inline style, which keeps the DOM tidy
 * for SSR snapshots.
 */
const wrapperStyle = $derived(
  role.color ? `--smrt-role-color: ${role.color};` : undefined,
);

function handleNavigate(): void {
  // Always close the mobile drawer on nav click — this is the behaviour
  // consumers historically wired up by hand. The optional `onNavigate`
  // prop lets them layer in additional side-effects (analytics, store
  // updates, etc.) without losing the close.
  mobileNavOpen = false;
  onNavigate?.();
}
</script>

<div class="smrt-role-shell" data-role-id={role.id} style={wrapperStyle}>
  <WorkspaceShell
    title={resolvedTitle}
    subtitle={resolvedSubtitle}
    {eyebrow}
    {modeLabel}
    {modeStatus}
    {modeDetail}
    {collapsed}
    {onToggleCollapsed}
    {collapsible}
    {showInspector}
    {inspectorTitle}
    {onCloseInspector}
    {sidebarFooter}
    {topbarActions}
    {inspector}
    {inspectorRail}
    bind:mobileNavOpen
  >
    {#snippet brand()}
      {#if consumerBrand}
        {@render consumerBrand()}
      {:else}
        {#if role.icon}
          <span class="smrt-role-shell-icon" aria-hidden="true">{role.icon}</span>
        {/if}
        {#if resolvedTitle}
          <h1>{resolvedTitle}</h1>
        {/if}
        {#if resolvedSubtitle}
          <p class="subtitle">{resolvedSubtitle}</p>
        {/if}
      {/if}
    {/snippet}

    {#snippet nav()}
      <NavTree
        items={role.sections}
        {currentPath}
        iconComponent={navIconComponent}
        onNavigate={handleNavigate}
        collapsed={collapsed ?? false}
      />
    {/snippet}

    {#if showBreadcrumbs}
      <Breadcrumbs
        nav={role.sections}
        pathname={currentPath}
        rootCrumb={resolvedRootCrumb}
        startAfter={resolvedBreadcrumbStartAfter}
      />
    {/if}
    {@render children()}
  </WorkspaceShell>
</div>

<style>
  /*
   * Display: contents lets the WorkspaceShell drive the grid/layout while
   * still giving us a single DOM node to hang `--smrt-role-color` off.
   * The wrapper element exists purely to scope the custom property; it
   * never participates in layout.
   */
  .smrt-role-shell {
    display: contents;
  }

  /*
   * The default brand snippet renders the role icon as a leading glyph.
   * Sized to match `<h1>` line-height so the icon stays vertically aligned
   * with the title baseline. Consumer-provided `brand` snippets bypass
   * this entirely.
   */
  .smrt-role-shell-icon {
    display: inline-block;
    margin-right: 0.4rem;
    font-size: 1.1rem;
    line-height: 1;
    color: var(--smrt-role-color, var(--smrt-color-on-surface, #111827));
  }
</style>
