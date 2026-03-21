<script lang="ts">
import { ThemeProvider } from '@happyvertical/smrt-svelte/themes';
import { page } from '$app/stores';

let { children } = $props();

const navItems = [
  { href: '/', label: 'Contents', icon: '📝' },
  { href: '/governance', label: 'Governance', icon: '🛡️' },
  { href: '/contributions', label: 'Contributions', icon: '📬' },
  { href: '/api-explorer', label: 'API Explorer', icon: '🔌' },
];
</script>

<ThemeProvider colorScheme="system" persist={true}>
<div class="app-shell">
  <header class="app-header">
    <div class="header-inner">
      <a href="/" class="brand">📝 <span>Content Service</span></a>
      <nav class="nav-tabs">
        {#each navItems as item}
          <a
            href={item.href}
            class="nav-tab"
            class:active={$page.url.pathname === item.href || (item.href !== '/' && $page.url.pathname.startsWith(item.href))}
          >
            <span class="nav-icon">{item.icon}</span>
            {item.label}
          </a>
        {/each}
      </nav>
      <div class="header-status">Online</div>
    </div>
  </header>

  <main class="app-main">
    {@render children()}
  </main>

  <footer class="app-footer">
    <p>SMRT Content Service &middot; PR #1037 Dev Preview</p>
  </footer>
</div>
</ThemeProvider>

<style>
  :global(body) {
    margin: 0;
    font-family: var(--smrt-font-family, 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    background: var(--smrt-color-background, #f0f2f5);
    color: var(--smrt-color-on-background, #1a1c1e);
    min-height: 100vh;
  }

  .app-shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .app-header {
    background: var(--smrt-color-surface, #fff);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    position: sticky;
    top: 0;
    z-index: 100;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }

  .header-inner {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 1.5rem;
    display: flex;
    align-items: center;
    gap: 1.5rem;
    height: 56px;
  }

  .brand {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--smrt-color-on-surface, #1a1c1e);
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }

  .nav-tabs {
    display: flex;
    gap: 0.25rem;
    flex: 1;
    justify-content: center;
  }

  .nav-tab {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    text-decoration: none;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .nav-tab:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .nav-tab.active {
    background: var(--smrt-color-primary-container, #d8e2ff);
    color: var(--smrt-color-on-primary-container, #001a41);
    font-weight: 600;
  }

  .nav-icon {
    font-size: 1rem;
  }

  .header-status {
    background: var(--smrt-color-success, #10b981);
    color: white;
    padding: 0.2rem 0.6rem;
    border-radius: 1rem;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .app-main {
    flex: 1;
    max-width: 1400px;
    width: 100%;
    margin: 0 auto;
    padding: 1.5rem;
  }

  .app-footer {
    text-align: center;
    padding: 1.25rem 0;
    color: var(--smrt-color-on-surface-variant, #74777f);
    font-size: 0.8125rem;
    opacity: 0.7;
  }
</style>
