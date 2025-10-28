<script lang="ts">
import type { Snippet } from 'svelte';

interface Props {
  children?: Snippet;
}

// biome-ignore lint/correctness/noUnusedVariables: Variables used in Svelte template
const { children }: Props = $props();

const _currentYear = new Date().getFullYear();
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
    background: var(--color-neutral-gray100);
    border-top: 1px solid var(--color-neutral-gray200);
    padding: var(--spacing-2xl) 0;
    margin-top: var(--spacing-3xl);
    text-align: center;
    color: var(--color-text-secondary);
  }

  .footer-content {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
    align-items: center;
  }

  .copyright {
    margin: 0;
    font-size: var(--font-size-sm);
  }

  .footer-links :global(a) {
    color: var(--color-primary-main);
    text-decoration: none;
    margin: 0 var(--spacing-sm);
  }

  .footer-links :global(a:hover) {
    text-decoration: underline;
  }
</style>
