<script lang="ts">
  import type { LayoutData } from './$types';
  import '../app.css';
  import { Masthead, WeatherHeader, Footer, Container } from '@happyvertical/smrt-svelte';

  let { children, data }: { children: any; data: LayoutData } = $props();

  const { siteConfig, weather } = data;
</script>

<svelte:head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content={siteConfig.theme?.primaryColor || '#1976d2'} />
  {#if siteConfig.meta?.gtmId}
    <!-- Google Tag Manager -->
    {@html `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${siteConfig.meta.gtmId}');</script>`}
  {/if}
</svelte:head>

<div class="layout">
  <div class="weather-header">
    <Container>
      <WeatherHeader forecast={weather} />
    </Container>
  </div>

  <Masthead location={siteConfig.location.name}>
    {#snippet nav()}
      {#each siteConfig.navigation.primary as link}
        <a href={link.href}>{link.label}</a>
      {/each}
    {/snippet}
  </Masthead>

  <main class="main">
    <Container>
      {@render children?.()}
    </Container>
  </main>

  <Footer>
    {#snippet children()}
      {#each siteConfig.navigation.footer || [] as link, i}
        {#if i > 0} • {/if}
        <a href={link.href}>{link.label}</a>
      {/each}
    {/snippet}
  </Footer>
</div>

<style>
  .layout {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  .weather-header {
    background: var(--color-neutral-white);
    border-bottom: 1px solid var(--color-neutral-gray300);
  }

  .main {
    flex: 1;
    padding: var(--spacing-xl) 0;
  }
</style>
