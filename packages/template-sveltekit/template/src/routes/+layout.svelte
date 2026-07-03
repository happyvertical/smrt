<script lang="ts">
  import { page } from '$app/state';
  import {
    AdminShell,
    AppScopePanel,
    type ShellStatusChip,
    SystemStatusChips,
    TenantNav,
  } from '@happyvertical/smrt-svelte/workspace';
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
  // Self-hosted @font-face rules for the SMRT type stack (Space Grotesk /
  // Inter / JetBrains Mono woff2). `<ThemeProvider>` supplies every `--smrt-*`
  // token variable at runtime, but not the font FILES — this import loads them
  // so `--smrt-font-family` renders as the real stack instead of falling back
  // to system-ui. Bundled with the app; no CDN request.
  import '@happyvertical/smrt-ui/themes/styles/fonts.css';
  import type { LayoutProps } from './$types';

  // `data.nav` is built server-side in `+layout.server.ts` from the SMRT
  // manifest and hydrated here — no client-side nav fetch. `children` is the
  // active page, which renders inside AdminShell's `<main>` and keeps its own
  // server load + `invalidate` flow (see `+page.server.ts`).
  let { data, children }: LayoutProps = $props();

  // Both wrappers are SSR-safe. ThemeProvider emits its `--smrt-*` token
  // variables as an inline style computed during render (no `window`), so the
  // tokens are present in the server HTML with no unstyled flash; it only reads
  // `matchMedia` after mount to resolve `colorScheme="system"`. AdminShell's
  // public core likewise renders statically and only wires WASD hotkeys /
  // localStorage persistence after mount. Nothing here reads `window` or
  // `localStorage` at module or render time. `$app/state`'s `page` is populated
  // on the server too, so `currentHref` is correct on first paint.
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

<!--
  ThemeProvider is the standard SMRT theming wrapper (mirrors the reference app
  `@happyvertical/smrt-content` → `src/routes/+layout.svelte`). It injects the
  full `--smrt-*` token set the shell and pages consume, and `colorScheme="system"`
  follows the OS light/dark preference at runtime; `persist` remembers a user's
  explicit choice. Wrap it OUTERMOST so AdminShell and every page render themed.
-->
<ThemeProvider colorScheme="system" persist={true}>
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
</ThemeProvider>

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
