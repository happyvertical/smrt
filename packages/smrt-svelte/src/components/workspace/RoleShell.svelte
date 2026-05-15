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
 * See `happyvertical/smrt#1226` (Phase 4b) for design notes. The
 * SmrtObject-aware piece was originally scoped here but has been
 * deferred — this primitive is intentionally cheap and low-blast-radius.
 */
import type { Snippet } from 'svelte';
import Breadcrumbs from './Breadcrumbs.svelte';
import NavTree from './NavTree.svelte';
import type { RoleConfig } from './types.js';
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
  /** Optional: brand snippet — passes through to `WorkspaceShell`. */
  brand?: Snippet;
  /** Optional: sidebar footer (account menu, tenant switcher) — passes through. */
  sidebarFooter?: Snippet;
  /** Optional: topbar actions — passes through. */
  topbarActions?: Snippet;
  /** Optional: inspector panel — passes through. */
  inspector?: Snippet;
  /** Optional: inspector rail — passes through. */
  inspectorRail?: Snippet;
  /** Required: main content. */
  children: Snippet;
  /** Optional: bind mobile drawer state for external control. */
  mobileNavOpen?: boolean;
  /** Optional: show breadcrumbs (default: true). */
  showBreadcrumbs?: boolean;
}

let {
  roles,
  currentRole,
  currentPath,
  title,
  subtitle,
  brand,
  sidebarFooter,
  topbarActions,
  inspector,
  inspectorRail,
  children,
  mobileNavOpen = $bindable(false),
  showBreadcrumbs = true,
}: Props = $props();

const role = $derived.by(() => {
  const found = roles.find((r) => r.id === currentRole);
  if (!found) {
    throw new Error(
      `[RoleShell] No role found for id "${currentRole}". ` +
        `Available role ids: ${roles.map((r) => r.id).join(', ') || '(none)'}.`,
    );
  }
  return found;
});

const resolvedTitle = $derived(title ?? role.label);
const resolvedSubtitle = $derived(subtitle ?? role.description ?? '');
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
</script>

<div class="smrt-role-shell" data-role-id={role.id} style={wrapperStyle}>
  <WorkspaceShell
    title={resolvedTitle}
    subtitle={resolvedSubtitle}
    {brand}
    {sidebarFooter}
    {topbarActions}
    {inspector}
    {inspectorRail}
    bind:mobileNavOpen
  >
    {#snippet nav()}
      <NavTree
        items={role.sections}
        {currentPath}
        onNavigate={() => {
          mobileNavOpen = false;
        }}
      />
    {/snippet}

    {#if showBreadcrumbs}
      <Breadcrumbs
        nav={role.sections}
        pathname={currentPath}
        rootCrumb={{ label: role.label, href: `/${role.id}` }}
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
</style>
