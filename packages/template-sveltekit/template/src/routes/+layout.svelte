<script lang="ts">
  import { page } from '$app/state';
  import { Provider } from '@happyvertical/smrt-svelte';
  import {
    AdminShell,
    AppScopePanel,
    type ShellNavItem,
    TenantNav,
  } from '@happyvertical/smrt-svelte/workspace';
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
  import '@happyvertical/smrt-ui/themes/styles/fonts.css';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();

  const currentHref = $derived(page.url.pathname);
  const activeTenantLabel = $derived(
    data.session.activeTenantId ? 'Authorized session tenant' : 'No active tenant',
  );

  // Add application routes here. Generated REST routes live under /api and do
  // not automatically imply a human-facing page.
  const nav: ShellNavItem[] = [
    {
      href: '/',
      label: 'Items',
      description: 'The example s-m-r-t object',
    },
    {
      href: '/settings',
      label: 'Settings',
      description: 'Workspace layout and shortcuts',
    },
  ];
</script>

<Provider>
  <ThemeProvider preset="smrt" colorScheme="system" persist={true}>
    <AdminShell
      title="s-m-r-t app"
      subtitle="SvelteKit"
      storageKey="smrt-app-shell"
    >
      {#snippet appPanel()}
        <AppScopePanel
          appName="s-m-r-t app"
          tenantName={activeTenantLabel}
          environment="local"
          showSettings={false}
        >
          {#snippet docs()}
            {#if data.session.selectedTenantSlug}
              <p class="tenant-selection">
                Selected URL tenant: <strong>{data.session.selectedTenantSlug}</strong>
              </p>
            {/if}
            <a href="/settings">Shell settings</a>
          {/snippet}
        </AppScopePanel>
      {/snippet}

      {#snippet tenantPanel()}
        <TenantNav items={nav} {currentHref} />
      {/snippet}

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
    font-family: var(--smrt-typography-body-font-family, Inter, system-ui, sans-serif);
  }

  .tenant-selection {
    margin: 0 0 var(--smrt-spacing-2);
    color: var(--smrt-color-on-surface-variant);
  }

  a {
    color: var(--smrt-color-primary);
  }
</style>
