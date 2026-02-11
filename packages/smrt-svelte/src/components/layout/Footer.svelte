<script lang="ts">
import type { Snippet } from 'svelte';
import Container from './Container.svelte';

export interface Props {
  children?: Snippet;
}

const { children }: Props = $props();

const currentYear = new Date().getFullYear();
</script>

<footer class="site-footer">
  <Container>
    <div class="footer-content">
      <p class="copyright">&copy; {currentYear} All rights reserved.</p>

      {#if children}
        <div class="footer-links">
          {@render children()}
        </div>
      {/if}
    </div>
  </Container>
</footer>

<style>
  .site-footer {
    background: var(--smrt-color-surface-container-low);
    border-top: 1px solid var(--smrt-color-outline-variant);
    padding: var(--smrt-spacing-8) 0;
    margin-top: var(--smrt-spacing-12);
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }

  .footer-content {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4);
    align-items: center;
  }

  .copyright {
    margin: 0;
    font-size: var(--smrt-typography-body-medium-size);
  }

  .footer-links :global(a) {
    color: var(--smrt-color-primary);
    text-decoration: none;
    margin: 0 var(--smrt-spacing-2);
  }

  .footer-links :global(a:hover) {
    text-decoration: underline;
  }
</style>
