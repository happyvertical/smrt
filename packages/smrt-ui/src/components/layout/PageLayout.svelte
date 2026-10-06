<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
import Container from './Container.svelte';

type MaxWidth = 'sm' | 'md' | 'lg' | 'xl' | 'full';
type Gap = 'sm' | 'md' | 'lg';

export interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
  /** Maximum width of the page content. */
  maxWidth?: MaxWidth;
  /** Vertical space between the page's direct children. */
  gap?: Gap;
  /** CSS classes appended to the page content element. */
  class?: string;
  /** Page content. */
  children: Snippet;
}

const {
  maxWidth = 'lg',
  gap = 'md',
  class: className = '',
  children,
  ...rest
}: Props = $props();
</script>

<Container {maxWidth} data-page-layout-container>
  <div class="page-layout gap-{gap} {className}" data-page-layout {...rest}>
    {@render children()}
  </div>
</Container>

<style>
  .page-layout {
    display: grid;
    min-inline-size: 0;
    padding-block: var(--smrt-spacing-5) var(--smrt-spacing-8);
    overflow-wrap: anywhere;
  }

  .gap-sm {
    gap: var(--smrt-spacing-3);
  }

  .gap-md {
    gap: var(--smrt-spacing-5);
  }

  .gap-lg {
    gap: var(--smrt-spacing-8);
  }

  @media (min-width: 640px) {
    .page-layout {
      padding-block: var(--smrt-spacing-6) var(--smrt-spacing-10);
    }
  }
</style>
