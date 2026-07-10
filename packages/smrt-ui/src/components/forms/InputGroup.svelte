<script lang="ts">
import type { Snippet } from 'svelte';
export interface Props {
  prefix?: Snippet;
  suffix?: Snippet;
  children: Snippet;
  class?: string;
}
let { prefix, suffix, children, class: className = '' }: Props = $props();
</script>
<div class="input-group {className}">{#if prefix}<span class="adornment">{@render prefix()}</span>{/if}<div class="control">{@render children()}</div>{#if suffix}<span class="adornment">{@render suffix()}</span>{/if}</div>
<style>
  .input-group { display: flex; align-items: stretch; width: 100%; border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface); overflow: hidden; }
  .adornment { display: inline-flex; align-items: center; padding: 0 var(--smrt-spacing-3); background: var(--smrt-color-surface-container-low); color: var(--smrt-color-on-surface-variant); }
  .control { flex: 1; min-width: 0; } .control :global(input), .control :global(select), .control :global(textarea) { border: 0 !important; border-radius: 0 !important; box-shadow: none !important; }
  .input-group:focus-within { outline: 2px solid var(--smrt-color-primary); outline-offset: 1px; }
</style>
