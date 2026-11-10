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
  <div class="smrt-page-layout__root smrt-page-layout__gap-{gap} {className}" data-page-layout {...rest}>
    {@render children()}
  </div>
</Container>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-page-layout__root {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-inline-size: 0;
    padding-block: var(--smrt-spacing-5) var(--smrt-spacing-8);
    overflow-wrap: anywhere;
  }
  .smrt-page-layout__gap-sm {
    gap: var(--smrt-spacing-3);
  }
  .smrt-page-layout__gap-md {
    gap: var(--smrt-spacing-5);
  }
  .smrt-page-layout__gap-lg {
    gap: var(--smrt-spacing-8);
  }
  @media (min-width: 640px) {
    .smrt-page-layout__root {
      padding-block: var(--smrt-spacing-6) var(--smrt-spacing-10);
    }
  }
}

@layer smrt.theme {
}

</style>
