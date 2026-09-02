<script lang="ts">
import type { Snippet } from 'svelte';
import { setAccordionContext } from './accordion-context.js';

export interface Props {
  /** The currently open item identifier(s); array if multiple is true. */
  value?: string | string[];
  /** Allows multiple items to be open simultaneously. */
  multiple?: boolean;
  /** The AccordionItem components. */
  children?: Snippet;
  /** Fired when the open/closed state of an item changes. */
  onvaluechange?: (value: string | string[]) => void;
  /** Additional CSS class names. */
  class?: string;
}

let {
  value = $bindable(''),
  multiple = false,
  children,
  onvaluechange,
  class: className = '',
}: Props = $props();

function isOpen(item: string) {
  return Array.isArray(value) ? value.includes(item) : value === item;
}

function toggle(item: string) {
  if (multiple) {
    const current = Array.isArray(value) ? value : value ? [value] : [];
    value = current.includes(item)
      ? current.filter((entry) => entry !== item)
      : [...current, item];
  } else {
    value = value === item ? '' : item;
  }
  onvaluechange?.(value);
}

setAccordionContext({ isOpen, toggle });
</script>

<div class="accordion {className}">{#if children}{@render children()}{/if}</div>

<style>
  .accordion { overflow: hidden; border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-large); background: var(--smrt-color-surface); }
</style>
