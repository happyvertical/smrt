<script lang="ts">
import type { Snippet } from 'svelte';
import { getAccordionContext } from './accordion-context.js';

export interface Props {
  value: string;
  title: string;
  disabled?: boolean;
  children?: Snippet;
}
let { value, title, disabled = false, children }: Props = $props();
const instanceId = $props.id();
const triggerId = `accordion-trigger-${instanceId}`;
const panelId = `accordion-panel-${instanceId}`;
const context = getAccordionContext();
const open = $derived(context.isOpen(value));
</script>

<section class="item">
  <h3>
    <button id={triggerId} type="button" aria-expanded={open} aria-controls={panelId} {disabled} onclick={() => context.toggle(value)}>
      <span>{title}</span><span class="chevron" aria-hidden="true">⌄</span>
    </button>
  </h3>
  {#if open}
    <div id={panelId} role="region" aria-labelledby={triggerId} class="panel">{#if children}{@render children()}{/if}</div>
  {/if}
</section>

<style>
  .item { border-bottom: 1px solid var(--smrt-color-outline-variant); }
  .item:last-child { border-bottom: 0; }
  h3 { margin: 0; }
  button { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-3); padding: var(--smrt-spacing-4); border: 0; background: transparent; color: var(--smrt-color-on-surface); font: var(--smrt-typography-title-small-font); text-align: left; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--smrt-color-surface-container-low); }
  button:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: -2px; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .chevron { transition: transform var(--smrt-duration-short4) var(--smrt-easing-standard); }
  button[aria-expanded='true'] .chevron { transform: rotate(180deg); }
  .panel { padding: 0 var(--smrt-spacing-4) var(--smrt-spacing-4); color: var(--smrt-color-on-surface-variant); }
  @media (prefers-reduced-motion: reduce) { .chevron { transition: none; } }
</style>
