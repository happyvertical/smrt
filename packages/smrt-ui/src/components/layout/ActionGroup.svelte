<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

type Gap = 'sm' | 'md';
type Justify = 'start' | 'end';

export interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
  /** Space between actions. */
  gap?: Gap;
  /** Horizontal alignment when the row has spare space. */
  justify?: Justify;
  /** CSS classes appended to the action group. */
  class?: string;
  /** Buttons, button links, or other compact actions. */
  children: Snippet;
}

const {
  gap = 'sm',
  justify = 'start',
  class: className = '',
  children,
  ...rest
}: Props = $props();
</script>

<div class="action-group gap-{gap} justify-{justify} {className}" {...rest}>
  {@render children()}
</div>

<style>
  .action-group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    min-inline-size: 0;
  }

  .gap-sm {
    gap: var(--smrt-spacing-2);
  }

  .gap-md {
    gap: var(--smrt-spacing-3);
  }

  .justify-start {
    justify-content: flex-start;
  }

  .justify-end {
    justify-content: flex-end;
  }
</style>
