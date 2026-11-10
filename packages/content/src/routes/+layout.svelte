<script lang="ts">
import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
import { page } from '$app/stores';
import { CONTENT_DEFAULT_ROUTE_NAVIGATION } from '../svelte/routes/shared.js';

let { children } = $props();

const navItems = [
  { href: '/', label: 'Playground', icon: '🎛️' },
  ...CONTENT_DEFAULT_ROUTE_NAVIGATION.map((item) => ({
    href: item.href,
    label:
      item.routeId === 'content.governance'
        ? 'Governance'
        : item.routeId === 'content.contributions'
          ? 'Contributions'
          : item.label,
    icon:
      item.routeId === 'content.workspace'
        ? '📝'
        : item.routeId === 'content.governance'
          ? '🛡️'
          : '📬',
  })),
  { href: '/api-explorer', label: 'API Explorer', icon: '🔌' },
];
</script>

<ThemeProvider colorScheme="system" persist={true}>
<div class="smrt-app-layout__root">
  <header class="smrt-app-layout__header" data-smrt-part="header">
    <div class="smrt-app-layout__toolbar" data-smrt-part="toolbar">
      <a href="/" class="smrt-app-layout__brand" data-smrt-part="brand">📝 <span>Content Service</span></a>
      <nav class="smrt-app-layout__nav" data-smrt-part="nav">
        {#each navItems as item}
          <a
            href={item.href}
            class="smrt-app-layout__tab"
            data-smrt-part="tab"
            class:smrt-app-layout__active={$page.url.pathname === item.href || (item.href !== '/' && $page.url.pathname.startsWith(item.href))}
          >
            <span class="smrt-app-layout__icon" data-smrt-part="icon">{item.icon}</span>
            {item.label}
          </a>
        {/each}
      </nav>
      <div class="smrt-app-layout__status" data-smrt-part="status">Online</div>
    </div>
  </header>

  <main class="smrt-app-layout__main" data-smrt-part="main">
    {@render children()}
  </main>

  <footer class="smrt-app-layout__footer" data-smrt-part="footer">
    <p>SMRT Content Service &middot; Development build</p>
  </footer>
</div>
</ThemeProvider>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  :global(body) {
    margin: 0;
    min-height: 100vh;
  }
  .smrt-app-layout__root {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .smrt-app-layout__header {
    position: sticky;
    top: 0;
    z-index: var(--smrt-z-index-sticky, 1100);
  }
  .smrt-app-layout__toolbar {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 1.5rem;
    display: flex;
    align-items: center;
    gap: 1.5rem;
    height: 56px;
  }
  .smrt-app-layout__brand {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }
  .smrt-app-layout__nav {
    display: flex;
    gap: 0.25rem;
    flex: 1;
    justify-content: center;
  }
  .smrt-app-layout__tab {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.5rem 1rem;
    white-space: nowrap;
  }
  .smrt-app-layout__status {
    padding: 0.2rem 0.6rem;
    white-space: nowrap;
  }
  .smrt-app-layout__main {
    flex: 1;
    max-width: 1400px;
    width: 100%;
    margin: 0 auto;
    padding: 1.5rem;
  }
  .smrt-app-layout__footer {
    padding: 1.25rem 0;
  }
}

@layer smrt.theme {
  :global(body) {
    font-family: var(--smrt-font-family, 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    background: var(--smrt-color-background);
    color: var(--smrt-color-on-background);
  }
  .smrt-app-layout__header {
    background: var(--smrt-color-surface);
    border-bottom: var(--smrt-hairline);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px color-mix(in srgb, var(--smrt-color-shadow) 6%, transparent));
  }
  .smrt-app-layout__brand {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface);
    text-decoration: none;
  }
  .smrt-app-layout__tab {
    border-radius: 0.5rem;
    text-decoration: none;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: all 0.15s ease;
  }
  .smrt-app-layout__tab:hover {
    background: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface);
  }
  .smrt-app-layout__tab.smrt-app-layout__active {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-app-layout__icon {
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }
  .smrt-app-layout__status {
    background: var(--smrt-color-success);
    color: white;
    border-radius: 1rem;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-app-layout__footer {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    opacity: 0.7;
  }
}

</style>
