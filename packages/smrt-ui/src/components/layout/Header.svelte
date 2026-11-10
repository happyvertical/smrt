<script lang="ts">
import type { Snippet } from 'svelte';
import Container from './Container.svelte';

export interface Props {
  /** Site logo or title content. */
  logo?: Snippet;
  /** Navigation links content. */
  nav?: Snippet;
}

const { logo, nav }: Props = $props();
</script>

<header class="smrt-header__root" data-smrt-component="Header">
  <Container>
    <div class="smrt-header__content" data-smrt-part="content">
      {#if logo}
        <div class="smrt-header__logo" data-smrt-part="title">
          {@render logo()}
        </div>
      {/if}

      {#if nav}
        <nav class="smrt-header__nav" data-smrt-part="list">
          {@render nav()}
        </nav>
      {/if}
    </div>
  </Container>
</header>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-header__root {
    padding: var(--smrt-spacing-4) 0;
  }
  .smrt-header__content {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4);
  }
  .smrt-header__logo :global(h1) {
    margin: 0;
  }
  .smrt-header__nav :global(a) {
    margin-right: var(--smrt-spacing-6);
  }
  @media (min-width: 768px) {
    .smrt-header__content {
      flex-direction: row;
      justify-content: space-between;
      align-items: center;
    }
  }
}

@layer smrt.theme {
  .smrt-header__root {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    box-shadow: var(--smrt-elevation-2);
  }
  .smrt-header__logo :global(h1) {
    font-size: var(--smrt-typography-display-small-size);
    font-weight: var(--smrt-typography-display-small-weight);
  }
  .smrt-header__logo :global(a) {
    color: var(--smrt-color-on-primary);
    text-decoration: none;
  }
  .smrt-header__logo :global(a:hover) {
    color: var(--smrt-color-on-primary);
    opacity: 0.9;
  }
  .smrt-header__nav :global(a) {
    color: var(--smrt-color-on-primary);
    text-decoration: none;
    opacity: 0.95;
    transition: opacity var(--smrt-duration-short2) var(--smrt-easing-standard);
    font-weight: var(--smrt-typography-body-medium-weight);
  }
  .smrt-header__nav :global(a:hover) {
    opacity: 1;
    text-decoration: underline;
  }
  @media (min-width: 768px) {
    .smrt-header__logo :global(h1) {
      font-size: var(--smrt-typography-headline-medium-size);
    }
  }
}

</style>
