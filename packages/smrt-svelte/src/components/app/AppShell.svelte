<script lang="ts">
import {
  type ColorScheme,
  type ThemePreset,
  ThemeProvider,
} from '@happyvertical/smrt-ui/themes';
import '@happyvertical/smrt-ui/themes/styles/all.css';
import '@happyvertical/smrt-ui/themes/styles/fonts.css';
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { M } from '../../i18n/strings.workspace.js';
import Provider from '../../Provider.svelte';
import type { User } from '../../state/app-state.js';
import type { WebMcpProviderConfig } from '../../web/webmcp-provider.js';
import AdminShell from '../workspace/admin-shell/AdminShell.svelte';
import AppScopePanel from '../workspace/admin-shell/AppScopePanel.svelte';
import TenantNav from '../workspace/admin-shell/TenantNav.svelte';
import type {
  ShellNavGroup,
  ShellNavItem,
  ShellPanelDefaults,
} from '../workspace/admin-shell/types.js';
import DockSlot from './DockSlot.svelte';
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
  preset = 'smrt',
  colorScheme = 'system',
  appPanelDocs,
  dock,
  children,
}: Props = $props();
const { t } = useI18n();
const hasNav = $derived(nav.length > 0 || navGroups.length > 0);
</script>

<Provider {webmcp} {user} {permissions}>
  <RuntimeDiagnosticsWebMcp enabled={runtimeDiagnostics} />
  <ThemeProvider {preset} {colorScheme} persist={true}>
    <AdminShell {title} {subtitle} {storageKey} {config} path={currentHref}>
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
            items={nav}
            groups={navGroups}
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
  :global(*),
  :global(*::before),
  :global(*::after) {
    box-sizing: border-box;
  }
  :global(html),
  :global(body) {
    min-height: 100%;
    margin: 0;
  }
  :global(body) {
    background: var(--smrt-color-background);
    color: var(--smrt-color-on-background);
    font-family: var(--smrt-font-family, Inter, system-ui, sans-serif);
  }
  a {
    color: var(--smrt-color-primary);
  }
</style>
