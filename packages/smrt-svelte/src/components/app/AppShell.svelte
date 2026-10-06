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
import { type Snippet, untrack } from 'svelte';
import { M } from '../../i18n/strings.workspace.js';
import Provider from '../../Provider.svelte';
import type { User } from '../../state/app-state.js';
import type { WebMcpProviderConfig } from '../../web/webmcp-provider.js';
import AdminShell from '../workspace/admin-shell/AdminShell.svelte';
import AppScopePanel from '../workspace/admin-shell/AppScopePanel.svelte';
import {
  applyShellLayout,
  normalizeShellLayout,
  type ShellLayout,
} from '../workspace/admin-shell/layout.js';
import { setShellLayout } from '../workspace/admin-shell/layout-context.js';
import { ShellLayoutController } from '../workspace/admin-shell/layout-controller.svelte.js';
import { createShellState } from '../workspace/admin-shell/state.svelte.js';
import TenantNav from '../workspace/admin-shell/TenantNav.svelte';
import type {
  ShellNavGroup,
  ShellNavItem,
  ShellPanelDefaults,
} from '../workspace/admin-shell/types.js';
import DockSlot from './DockSlot.svelte';
import DockToggles from './DockToggles.svelte';
import type { DockToggle } from './dock-toggle.js';
import RuntimeDiagnosticsWebMcp from './RuntimeDiagnosticsWebMcp.svelte';

interface Props {
  /** Application name shown in the shell brand and app panel. */
  title?: string;
  /** Secondary line under the application name in the shell brand. */
  subtitle?: string;
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
   * Icon buttons rendered at the right of the shell header, each toggling
   * the `ShellDockTool` with the same id open and closed. `aria-pressed` and
   * `aria-expanded` follow the dock, focus moves into the dock when it
   * opens and back to the button when it closes (Escape included). The
   * `assistant` tool defaults to a chat-bubble icon. Hosts and assistants can
   * drive the same dock from code with `useShellDock()`.
   */
  dockToggles?: DockToggle[];
  children: Snippet;
}

let {
  title = 'SMRT',
  subtitle,
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
  children,
}: Props = $props();
const { t } = useI18n();

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

$effect(() => {
  shell.setLayoutPanels(effectiveLayout.panels ?? {});
});

setShellLayout(
  new ShellLayoutController({
    nav: () => nav,
    groups: () => navGroups,
    panels: () => config,
    layout: () => effectiveLayout,
    commit(next) {
      if (!controlled) {
        if (onlayoutchange) localLayout = next;
        else shell.setLayout(next);
      }
      onlayoutchange?.(next);
    },
  }),
);
</script>

{#snippet dockHeader()}
  <DockToggles toggles={dockToggles} />
{/snippet}

<Provider {webmcp} {user} {permissions}>
  <RuntimeDiagnosticsWebMcp enabled={runtimeDiagnostics} />
  <ThemeProvider {preset} {colorScheme} persist={true}>
    <AdminShell
      {title}
      {subtitle}
      state={shell}
      path={currentHref}
      header={dockToggles.length > 0 ? dockHeader : undefined}
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

      {#snippet tenantPanel()}
        {#if hasNav}
          <TenantNav
            items={applied.nav}
            groups={applied.groups}
            {currentHref}
            aria-label={t(M['ui.app_shell.navigation'])}
          />
        {/if}
      {/snippet}

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
</style>
