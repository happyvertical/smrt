<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

type MaxWidth = 'sm' | 'md' | 'lg' | 'xl' | 'full';

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
  maxWidth?: MaxWidth;
  children?: Snippet;
}

const { maxWidth = 'lg', children, ...rest }: Props = $props();
</script>

<div class="container max-w-{maxWidth}" {...rest}>
  {@render children?.()}
</div>

<style>
  .container {
    width: 100%;
    margin: 0 auto;
    padding-left: var(--spacing-md);
    padding-right: var(--spacing-md);
  }

  .max-w-sm {
    max-width: 640px;
  }

  .max-w-md {
    max-width: 768px;
  }

  .max-w-lg {
    max-width: 1024px;
  }

  .max-w-xl {
    max-width: 1280px;
  }

  .max-w-full {
    max-width: 100%;
  }

  @media (min-width: 640px) {
    .container {
      padding-left: var(--spacing-lg);
      padding-right: var(--spacing-lg);
    }
  }
</style>
