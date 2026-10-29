<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

type Gap = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
type Justify = 'start' | 'center' | 'end' | 'between';

export interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
  /** Stacking axis: `vertical` (a column) or `horizontal` (a row). */
  direction?: 'vertical' | 'horizontal';
  /** Space between children, from the spacing tokens. */
  gap?: Gap;
  /** Cross-axis alignment. Omit for the browser default (stretch). */
  align?: Align;
  /** Main-axis distribution. Omit for the start of the axis. */
  justify?: Justify;
  /** Let children wrap onto further lines when they do not fit. */
  wrap?: boolean;
  /** CSS classes appended to the stack. */
  class?: string;
  /** Stacked content. */
  children?: Snippet;
}

const {
  direction = 'vertical',
  gap = 'md',
  align,
  justify,
  wrap = false,
  class: className = '',
  children,
  ...rest
}: Props = $props();
</script>

<div
  class="stack stack-{direction} gap-{gap} {className}"
  class:wrap
  data-align={align}
  data-justify={justify}
  {...rest}
  data-smrt-component="Stack"
>
  {@render children?.()}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .stack {
    display: flex;
    min-inline-size: 0;
  }
  .stack-vertical { flex-direction: column; }
  .stack-horizontal { flex-direction: row; }
  .wrap { flex-wrap: wrap; }

  .gap-xs { gap: var(--smrt-spacing-1); }
  .gap-sm { gap: var(--smrt-spacing-2); }
  .gap-md { gap: var(--smrt-spacing-4); }
  .gap-lg { gap: var(--smrt-spacing-6); }
  .gap-xl { gap: var(--smrt-spacing-8); }

  .stack[data-align='start'] { align-items: flex-start; }
  .stack[data-align='center'] { align-items: center; }
  .stack[data-align='end'] { align-items: flex-end; }
  .stack[data-align='stretch'] { align-items: stretch; }
  .stack[data-align='baseline'] { align-items: baseline; }

  .stack[data-justify='start'] { justify-content: flex-start; }
  .stack[data-justify='center'] { justify-content: center; }
  .stack[data-justify='end'] { justify-content: flex-end; }
  .stack[data-justify='between'] { justify-content: space-between; }
}
</style>
