<script lang="ts">
import { onMount } from 'svelte';
import DemoPage from './pages/DemoPage.svelte';
import ProductsPage from './pages/ProductsPage.svelte';

// Simple client-side routing (can be replaced with proper router)
let currentPage = $state('demo');

onMount(() => {
  // Simple hash-based routing
  function handleHashChange() {
    const hash = window.location.hash.slice(1);
    currentPage = hash || 'products';
  }

  window.addEventListener('hashchange', handleHashChange);
  handleHashChange(); // Initial load

  return () => {
    window.removeEventListener('hashchange', handleHashChange);
  };
});
</script>

<div class="app">
  {#if currentPage === 'demo'}
    <DemoPage />
  {:else if currentPage === 'products'}
    <ProductsPage />
  {:else if currentPage === 'categories'}
    <div class="placeholder-page">
      <h2>Categories</h2>
      <p>Category management coming soon...</p>
    </div>
  {:else if currentPage === 'dashboard'}
    <div class="placeholder-page">
      <h2>Dashboard</h2>
      <p>Analytics dashboard coming soon...</p>
    </div>
  {:else}
    <DemoPage />
  {/if}
</div>

<style>
  .app {
    width: 100%;
    min-height: 100vh;
  }
  
  .placeholder-page {
    max-width: 1200px;
    margin: 0 auto;
    padding: 3rem 1rem;
    text-align: center;
  }
  
  .placeholder-page h2 {
    margin: 0 0 1rem 0;
    font-size: 2rem;
    color: #1f2937;
  }
  
  .placeholder-page p {
    margin: 0;
    color: #6b7280;
    font-size: 1.125rem;
  }
</style>