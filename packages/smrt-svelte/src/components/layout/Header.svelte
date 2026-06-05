<script lang="ts">
import type { Snippet } from 'svelte';
import Container from './Container.svelte';

export interface Props {
  logo?: Snippet;
  nav?: Snippet;
}

const { logo, nav }: Props = $props();
</script>

<header class="site-header">
  <Container>
    <div class="header-content">
      {#if logo}
        <div class="logo">
          {@render logo()}
        </div>
      {/if}

      {#if nav}
        <nav class="nav">
          {@render nav()}
        </nav>
      {/if}
    </div>
  </Container>
</header>

<style>
  .site-header {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    padding: var(--smrt-spacing-4) 0;
    box-shadow: var(--smrt-elevation-2);
  }

  .header-content {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4);
  }

  .logo :global(h1) {
    margin: 0;
    font-size: var(--smrt-typography-display-small-size);
    font-weight: var(--smrt-typography-display-small-weight);
  }

  .logo :global(a) {
    color: var(--smrt-color-on-primary);
    text-decoration: none;
  }

  .logo :global(a:hover) {
    color: var(--smrt-color-on-primary);
    opacity: 0.9;
  }

  .nav :global(a) {
    color: var(--smrt-color-on-primary);
    text-decoration: none;
    margin-right: var(--smrt-spacing-6);
    opacity: 0.95;
    transition: opacity var(--smrt-duration-short2) var(--smrt-easing-standard);
    font-weight: var(--smrt-typography-body-medium-weight);
  }

  .nav :global(a:hover) {
    opacity: 1;
    text-decoration: underline;
  }

  @media (min-width: 768px) {
    .header-content {
      flex-direction: row;
      justify-content: space-between;
      align-items: center;
    }

    .logo :global(h1) {
      font-size: var(--smrt-typography-headline-medium-size);
    }
  }
</style>
