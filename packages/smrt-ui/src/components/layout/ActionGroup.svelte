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

<div class="smrt-action-group__root smrt-action-group__gap-{gap} smrt-action-group__justify-{justify} {className}" {...rest} data-smrt-component="ActionGroup">
  {@render children()}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-action-group__root {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    min-inline-size: 0;
  }
  .smrt-action-group__gap-sm {
    gap: var(--smrt-spacing-2);
  }
  .smrt-action-group__gap-md {
    gap: var(--smrt-spacing-3);
  }
  .smrt-action-group__justify-start {
    justify-content: flex-start;
  }
  .smrt-action-group__justify-end {
    justify-content: flex-end;
  }
}

@layer smrt.theme {
}

</style>
