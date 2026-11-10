<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { M } from '../../lib/i18n.js';

interface Props {
  children: Snippet;
}

const { children }: Props = $props();
const { t } = useI18n();
</script>

<div class="smrt-app-layout__root" data-smrt-component="AppLayout">
  <header class="smrt-app-layout__header" data-smrt-part="header">
    <div class="smrt-app-layout__header-content" data-smrt-part="group">
      <h1 class="smrt-app-layout__title" data-smrt-part="title">
        <span class="smrt-app-layout__logo" data-smrt-part="icon">📦</span>
        {t(M['products.app_layout.service_title'])}
      </h1>
      
      <nav class="smrt-app-layout__nav" data-smrt-part="nav">
        <a href="#products" class="smrt-app-layout__nav-link" data-smrt-part="item">Products</a>
        <a href="#live" class="smrt-app-layout__nav-link" data-smrt-part="item">Live</a>
        <a href="#categories" class="smrt-app-layout__nav-link" data-smrt-part="item">Categories</a>
        <a href="#dashboard" class="smrt-app-layout__nav-link" data-smrt-part="item">Dashboard</a>
      </nav>
      
      <div class="smrt-app-layout__actions" data-smrt-part="actions">
        <span class="smrt-app-layout__status" data-smrt-part="status">
          <span class="smrt-app-layout__status-dot smrt-app-layout__online" data-smrt-part="icon"></span>
          Online
        </span>
      </div>
    </div>
  </header>
  
  <main class="smrt-app-layout__main" data-smrt-part="body">
    {@render children()}
  </main>
  
  <footer class="smrt-app-layout__footer" data-smrt-part="footer">
    <div class="smrt-app-layout__footer-content" data-smrt-part="group">
      <p>&copy; {t(M['products.app_layout.footer_copyright'])}</p>
      <div class="smrt-app-layout__footer-links" data-smrt-part="nav">
        <a href="#api-docs">{t(M['products.app_layout.api_docs'])}</a>
        <a href="#federation">Federation</a>
        <a href="#mcp-tools">{t(M['products.app_layout.mcp_tools'])}</a>
      </div>
    </div>
  </footer>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
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
  .smrt-app-layout__header-content {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
  }
  .smrt-app-layout__title {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-app-layout__nav {
    display: flex;
    gap: 1.5rem;
  }
  .smrt-app-layout__nav-link {
    padding: 0.5rem 1rem;
  }
  .smrt-app-layout__actions {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .smrt-app-layout__status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-app-layout__status-dot {
    width: 8px;
    height: 8px;
  }
  .smrt-app-layout__main {
    flex: 1;
    padding: 2rem 1rem;
  }
  .smrt-app-layout__footer {
    margin-top: auto;
  }
  .smrt-app-layout__footer-content {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.5rem 1rem;
  }
  .smrt-app-layout__footer-content p {
    margin: 0;
  }
  .smrt-app-layout__footer-links {
    display: flex;
    gap: 1.5rem;
  }
  @media (max-width: 768px) {
    .smrt-app-layout__header-content {
      flex-direction: column;
      gap: 1rem;
    }
    .smrt-app-layout__footer-content {
      flex-direction: column;
      gap: 1rem;
    }
    .smrt-app-layout__nav {
      flex-wrap: wrap;
      justify-content: center;
    }
  }
}

@layer smrt.theme {
  .smrt-app-layout__root {
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-app-layout__header {
    background: var(--smrt-color-surface);
    border-bottom: var(--smrt-hairline);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px color-mix(in srgb, var(--smrt-color-shadow) 10%, transparent));
  }
  .smrt-app-layout__title {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface);
  }
  .smrt-app-layout__logo {
    font-size: var(--smrt-typography-headline-medium-size, 1.75rem);
  }
  .smrt-app-layout__nav-link {
    color: var(--smrt-color-on-surface-variant);
    text-decoration: none;
    font-weight: var(--smrt-typography-weight-medium, 500);
    border-radius: var(--smrt-radius-sm);
    transition: all 0.2s;
  }
  .smrt-app-layout__nav-link:hover {
    color: var(--smrt-color-primary);
    background: var(--smrt-color-surface-container);
  }
  .smrt-app-layout__status {
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-app-layout__status-dot {
    border-radius: var(--smrt-radius-full);
  }
  .smrt-app-layout__status-dot.smrt-app-layout__online {
    background: var(--smrt-color-success);
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
  .smrt-app-layout__footer {
    background: var(--smrt-color-surface);
    border-top: var(--smrt-hairline);
  }
  .smrt-app-layout__footer-content p {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-app-layout__footer-links a {
    color: var(--smrt-color-on-surface-variant);
    text-decoration: none;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    transition: color 0.2s;
  }
  .smrt-app-layout__footer-links a:hover {
    color: var(--smrt-color-primary);
  }
  @media (max-width: 768px) {
    .smrt-app-layout__footer-content {
      text-align: center;
    }
  }
}

</style>