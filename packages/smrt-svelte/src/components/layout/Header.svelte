<script lang="ts">
import type { Snippet } from 'svelte';
import Container from './Container.svelte';

interface Props {
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
    background: var(--color-primary-main);
    color: var(--color-text-inverse);
    padding: var(--spacing-md) 0;
    box-shadow: var(--shadow-md);
  }

  .header-content {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
  }

  .logo :global(h1) {
    margin: 0;
    font-size: var(--font-size-3xl);
    font-weight: var(--font-weight-semibold);
  }

  .logo :global(a) {
    color: var(--color-text-inverse);
    text-decoration: none;
  }

  .logo :global(a:hover) {
    color: var(--color-text-inverse);
    opacity: 0.9;
  }

  .nav :global(a) {
    color: var(--color-text-inverse);
    text-decoration: none;
    margin-right: var(--spacing-lg);
    opacity: 0.95;
    transition: opacity var(--transition-fast);
    font-weight: var(--font-weight-medium);
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
      font-size: var(--font-size-2xl);
    }
  }
</style>
