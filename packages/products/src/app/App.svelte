<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { onMount } from 'svelte';
import { M } from '../lib/i18n.js';
import DemoPage from './pages/DemoPage.svelte';
// LiveProductsPage is itself engine-FREE: it reaches the `@happyvertical/smrt-web`
// runtime only through a dynamic `import()` (see the page), so importing the
// PAGE statically here keeps the ~76 kB engine in its own lazy chunk (#1761 ①).
import LiveProductsPage from './pages/LiveProductsPage.svelte';
import ProductsPage from './pages/ProductsPage.svelte';

const { t } = useI18n();

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

<div class="smrt-app__root" data-smrt-component="App">
  {#if currentPage === 'demo'}
    <DemoPage />
  {:else if currentPage === 'products'}
    <ProductsPage />
  {:else if currentPage === 'live'}
    <LiveProductsPage />
  {:else if currentPage === 'categories'}
    <div class="smrt-app__placeholder" data-smrt-part="content">
      <h2>Categories</h2>
      <p>{t(M['products.app.categories_coming_soon'])}</p>
    </div>
  {:else if currentPage === 'dashboard'}
    <div class="smrt-app__placeholder" data-smrt-part="content">
      <h2>Dashboard</h2>
      <p>{t(M['products.app.analytics_coming_soon'])}</p>
    </div>
  {:else}
    <DemoPage />
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-app__root {
    width: 100%;
    min-height: 100vh;
  }
  .smrt-app__placeholder {
    max-width: 1200px;
    margin: 0 auto;
    padding: 3rem 1rem;
  }
  .smrt-app__placeholder h2 {
    margin: 0 0 1rem 0;
  }
  .smrt-app__placeholder p {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-app__placeholder {
    text-align: center;
  }
  .smrt-app__placeholder h2 {
    font-size: var(--smrt-typography-headline-large-size, 2rem);
    color: var(--smrt-color-on-surface);
  }
  .smrt-app__placeholder p {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-large-size, 1.125rem);
  }
}

</style>