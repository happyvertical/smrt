<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../lib/i18n.js';

interface Props {
  children: any;
}

const { children }: Props = $props();
const { t } = useI18n();
</script>

<div class="app-layout">
  <header class="app-header">
    <div class="header-content">
      <h1 class="app-title">
        <span class="logo">📦</span>
        {t(M['products.app_layout.service_title'])}
      </h1>
      
      <nav class="main-nav">
        <a href="#products" class="nav-link">Products</a>
        <a href="#categories" class="nav-link">Categories</a>
        <a href="#dashboard" class="nav-link">Dashboard</a>
      </nav>
      
      <div class="header-actions">
        <span class="status-indicator">
          <span class="status-dot online"></span>
          Online
        </span>
      </div>
    </div>
  </header>
  
  <main class="app-main">
    {@render children()}
  </main>
  
  <footer class="app-footer">
    <div class="footer-content">
      <p>&copy; {t(M['products.app_layout.footer_copyright'])}</p>
      <div class="footer-links">
        <a href="#api-docs">{t(M['products.app_layout.api_docs'])}</a>
        <a href="#federation">Federation</a>
        <a href="#mcp-tools">{t(M['products.app_layout.mcp_tools'])}</a>
      </div>
    </div>
  </footer>
</div>

<style>
  .app-layout {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--smrt-color-surface-container-low, #f9fafb);
  }

  .app-header {
    background: var(--smrt-color-surface, #fff);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px color-mix(in srgb, var(--smrt-color-shadow, #000) 10%, transparent));
    position: sticky;
    top: 0;
    z-index: var(--smrt-z-index-sticky, 1100);
  }
  
  .header-content {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
  }
  
  .app-title {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface, #1f2937);
  }
  
  .logo {
    font-size: var(--smrt-typography-headline-medium-size, 1.75rem);
  }
  
  .main-nav {
    display: flex;
    gap: 1.5rem;
  }
  
  .nav-link {
    color: var(--smrt-color-on-surface-variant, #6b7280);
    text-decoration: none;
    font-weight: var(--smrt-typography-weight-medium, 500);
    padding: 0.5rem 1rem;
    border-radius: var(--smrt-radius-sm, 4px);
    transition: all 0.2s;
  }

  .nav-link:hover {
    color: var(--smrt-color-primary, #3b82f6);
    background: var(--smrt-color-surface-container, #f3f4f6);
  }
  
  .header-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  
  .status-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }
  
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: var(--smrt-radius-full, 9999px);
  }
  
  .status-dot.online {
    background: var(--smrt-color-success, #10b981);
    animation: pulse 2s infinite;
  }
  
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  
  .app-main {
    flex: 1;
    padding: 2rem 1rem;
  }
  
  .app-footer {
    background: var(--smrt-color-surface, #fff);
    border-top: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
    margin-top: auto;
  }
  
  .footer-content {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.5rem 1rem;
  }
  
  .footer-content p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  
  .footer-links {
    display: flex;
    gap: 1.5rem;
  }
  
  .footer-links a {
    color: var(--smrt-color-on-surface-variant, #6b7280);
    text-decoration: none;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    transition: color 0.2s;
  }

  .footer-links a:hover {
    color: var(--smrt-color-primary, #3b82f6);
  }
  
  @media (max-width: 768px) {
    .header-content {
      flex-direction: column;
      gap: 1rem;
    }
    
    .footer-content {
      flex-direction: column;
      gap: 1rem;
      text-align: center;
    }
    
    .main-nav {
      flex-wrap: wrap;
      justify-content: center;
    }
  }
</style>