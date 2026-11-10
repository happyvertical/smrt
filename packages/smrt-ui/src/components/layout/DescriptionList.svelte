<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

import type { DescriptionListItem } from './description-list.js';

export interface Props extends Omit<HTMLAttributes<HTMLDListElement>, 'class'> {
  /** Term/description pairs, rendered before any `children`. */
  items?: DescriptionListItem[];
  /** Extra `<dt>`/`<dd>` content, rendered after `items`. */
  children?: Snippet;
  /** CSS classes appended to the list. */
  class?: string;
}

const {
  items = [],
  children,
  class: className = '',
  ...rest
}: Props = $props();
</script>

<dl class="description-list {className}" {...rest} data-smrt-component="DescriptionList">
  {#each items as item, index (index)}
    <dt>{item.term}</dt>
    <dd>{item.description}</dd>
  {/each}
  {@render children?.()}
</dl>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .description-list {
    display: grid;
    grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
    column-gap: var(--smrt-spacing-6);
    row-gap: var(--smrt-spacing-2);
    margin: 0;
    min-inline-size: 0;
  }
  .description-list :global(dt) {
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-control-weight);
  }
  .description-list :global(dd) {
    margin: 0;
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }
  /* Collapse to one column on narrow screens. */
  @media (max-width: 40rem) {
    .description-list { grid-template-columns: minmax(0, 1fr); row-gap: 0; }
    .description-list :global(dd) { margin-block-end: var(--smrt-spacing-3); }
  }
}
</style>
