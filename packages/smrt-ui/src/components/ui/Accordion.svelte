<script lang="ts">
import type { Snippet } from 'svelte';
import { setAccordionContext } from './accordion-context.js';

export interface Props {
  value?: string | string[];
  multiple?: boolean;
  children?: Snippet;
  onvaluechange?: (value: string | string[]) => void;
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
