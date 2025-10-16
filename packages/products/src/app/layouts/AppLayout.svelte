<script lang="ts">
interface Props {
  children: any;
}

const { children }: Props = $props();
</script>

<div class="app-layout">
  <header class="app-header">
    <div class="header-content">
      <h1 class="app-title">
        <span class="logo">📦</span>
        Product Service
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
      <p>&copy; 2024 SMRT Product Service - Auto-generated with ❤️</p>
      <div class="footer-links">
        <a href="#api-docs">API Docs</a>
        <a href="#federation">Federation</a>
        <a href="#mcp-tools">MCP Tools</a>
      </div>
    </div>
  </footer>
</div>

<style>
  .app-layout {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background: #f9fafb;
  }
  
  .app-header {
    background: white;
    border-bottom: 1px solid #e2e8f0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    position: sticky;
    top: 0;
    z-index: 100;
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
    font-size: 1.5rem;
    font-weight: 700;
    color: #1f2937;
  }
  
  .logo {
    font-size: 1.75rem;
  }
  
  .main-nav {
    display: flex;
    gap: 1.5rem;
  }
  
  .nav-link {
    color: #6b7280;
    text-decoration: none;
    font-weight: 500;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    transition: all 0.2s;
  }
  
  .nav-link:hover {
    color: #3b82f6;
    background: #f3f4f6;
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
    font-size: 0.875rem;
    color: #6b7280;
  }
  
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  
  .status-dot.online {
    background: #10b981;
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
    background: white;
    border-top: 1px solid #e2e8f0;
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
    color: #6b7280;
    font-size: 0.875rem;
  }
  
  .footer-links {
    display: flex;
    gap: 1.5rem;
  }
  
  .footer-links a {
    color: #6b7280;
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.2s;
  }
  
  .footer-links a:hover {
    color: #3b82f6;
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