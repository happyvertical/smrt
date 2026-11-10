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
  class="smrt-stack__root smrt-stack__{direction} smrt-stack__gap-{gap} {className}"
  class:smrt-stack__wrap={wrap}
  data-align={align}
  data-justify={justify}
  {...rest}
  data-smrt-component="Stack"
>
  {@render children?.()}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-stack__root {
    display: flex;
    min-inline-size: 0;
  }
  .smrt-stack__vertical {
    flex-direction: column;
  }
  .smrt-stack__horizontal {
    flex-direction: row;
  }
  .smrt-stack__wrap {
    flex-wrap: wrap;
  }
  .smrt-stack__gap-xs {
    gap: var(--smrt-spacing-1);
  }
  .smrt-stack__gap-sm {
    gap: var(--smrt-spacing-2);
  }
  .smrt-stack__gap-md {
    gap: var(--smrt-spacing-4);
  }
  .smrt-stack__gap-lg {
    gap: var(--smrt-spacing-6);
  }
  .smrt-stack__gap-xl {
    gap: var(--smrt-spacing-8);
  }
  .smrt-stack__root[data-align='start'] {
    align-items: flex-start;
  }
  .smrt-stack__root[data-align='center'] {
    align-items: center;
  }
  .smrt-stack__root[data-align='end'] {
    align-items: flex-end;
  }
  .smrt-stack__root[data-align='stretch'] {
    align-items: stretch;
  }
  .smrt-stack__root[data-align='baseline'] {
    align-items: baseline;
  }
  .smrt-stack__root[data-justify='start'] {
    justify-content: flex-start;
  }
  .smrt-stack__root[data-justify='center'] {
    justify-content: center;
  }
  .smrt-stack__root[data-justify='end'] {
    justify-content: flex-end;
  }
  .smrt-stack__root[data-justify='between'] {
    justify-content: space-between;
  }
}

@layer smrt.theme {
}

</style>
