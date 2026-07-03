<script lang="ts">
  import { page } from '$app/state';
  import {
    AdminShell,
    AppScopePanel,
    type ShellStatusChip,
    SystemStatusChips,
    TenantNav,
  } from '@happyvertical/smrt-svelte/workspace';
  import type { LayoutProps } from './$types';

  // `data.nav` is built server-side in `+layout.server.ts` from the SMRT
  // manifest and hydrated here — no client-side nav fetch. `children` is the
  // active page, which renders inside AdminShell's `<main>` and keeps its own
  // server load + `invalidate` flow (see `+page.server.ts`).
  let { data, children }: LayoutProps = $props();

  // AdminShell's public core is SSR-safe: it renders statically on the server
  // and only wires WASD hotkeys / localStorage persistence after mount. So
  // everything below is safe to render during SSR — nothing here reads
  // `window` or `localStorage` at module or render time. `$app/state`'s `page`
  // is populated on the server too, so `currentHref` is correct on first paint.
  const currentHref = $derived(page.url.pathname);

  // Minimal, static system chips. Full live wiring (job counts, dispatch
  // depth, connection state) is a documented next step: feed real values
  // through `systemFeed` / `activityFeed` from `@happyvertical/smrt-svelte/web`
  // — see the migration guide and the playground `admin-shell-system-feed`
  // demo. Keeping these static here avoids loading the client engine on every
  // page of the scaffold.
  const statusChips: ShellStatusChip[] = [
    { id: 'env', label: 'Local', tone: 'info' },
    { id: 'connection', label: 'Ready', tone: 'success' },
  ];
</script>

<AdminShell title="SMRT App" subtitle="SvelteKit" storageKey="smrt-app-shell">
  {#snippet appPanel()}
    <AppScopePanel
      appName="SMRT App"
      tenantName="Local development"
      environment="local"
      showSettings={false}
    >
      {#snippet docs()}
        <nav class="app-scope-links">
          <a href="/settings">Shell settings</a>
        </nav>
      {/snippet}
    </AppScopePanel>
  {/snippet}

  {#snippet tenantPanel()}
    <TenantNav items={data.nav} {currentHref} />
  {/snippet}

  {#snippet systemBar()}
    <div class="system-bar">
      <SystemStatusChips chips={statusChips} />
      <a class="system-bar__settings" href="/settings">Settings</a>
    </div>
  {/snippet}

  {@render children()}
</AdminShell>

<style>
  :global(body) {
    margin: 0;
  }

  .app-scope-links {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  .app-scope-links a,
  .system-bar__settings {
    color: var(--smrt-color-primary);
    text-decoration: none;
  }

  .system-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
    inline-size: 100%;
  }
</style>
