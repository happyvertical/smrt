<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

type GapSize = 'sm' | 'md' | 'lg' | 'xl';

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
  columns?: number | 'auto';
  gap?: GapSize;
  children?: Snippet;
}

const { columns = 'auto', gap = 'md', children, ...rest }: Props = $props();

const _gridColumns = $derived(
  columns === 'auto'
    ? 'repeat(auto-fill, minmax(300px, 1fr))'
    : `repeat(${columns}, 1fr)`,
);
</script>

<div
  class="grid gap-{gap}"
  style="grid-template-columns: {_gridColumns}"
  {...rest}
>
  {@render children?.()}
</div>

<style>
  .grid {
    display: grid;
  }

  .gap-sm {
    gap: var(--spacing-md);
  }

  .gap-md {
    gap: var(--spacing-lg);
  }

  .gap-lg {
    gap: var(--spacing-xl);
  }

  .gap-xl {
    gap: var(--spacing-2xl);
  }
</style>
