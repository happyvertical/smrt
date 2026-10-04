<script lang="ts">
  import { page } from '$app/state';
  import { webMcpToolDefinitions } from '@happyvertical/smrt-virt-web';
  import { AppShell } from '@happyvertical/smrt-svelte/app';
  import type { ShellNavItem } from '@happyvertical/smrt-svelte/workspace';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();

  // Add application routes here. Generated REST routes live under /api and do
  // not automatically imply a human-facing page.
  const nav: ShellNavItem[] = [
    { href: '/', label: 'Items', description: 'The example s-m-r-t object' },
    { href: '/settings', label: 'Settings', description: 'Workspace layout and shortcuts' },
  ];

  // Generated read-only WebMCP tools, only in browsers that expose WebMCP.
  const webmcp = $derived(
    typeof document !== 'undefined' && 'modelContext' in document
      ? { definitions: webMcpToolDefinitions, basePath: '/api', effects: ['read'] as const }
      : false,
  );
</script>

<AppShell
  title="s-m-r-t app"
  subtitle="SvelteKit"
  {webmcp}
  {nav}
  currentHref={page.url.pathname}
  runtimeDiagnostics={data.session.authenticated}
  tenantLabel={data.session.activeTenantId ? 'Authorized session tenant' : 'No active tenant'}
  settingsHref="/settings"
>
  {#snippet appPanelDocs()}
    {#if data.session.selectedTenantSlug}
      <p>Selected URL tenant: <strong>{data.session.selectedTenantSlug}</strong></p>
    {/if}
  {/snippet}
  {@render children()}
</AppShell>
