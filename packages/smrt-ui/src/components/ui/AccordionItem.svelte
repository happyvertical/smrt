<script lang="ts">
import type { Snippet } from 'svelte';
import { getAccordionContext } from './accordion-context.js';

export interface Props {
  /** Unique identifier for this accordion item. */
  value: string;
  /** Header text displayed in the item button. */
  title: string;
  /** Blocks opening and closing this item. */
  disabled?: boolean;
  /** The content shown when the item is open. */
  children?: Snippet;
}
let { value, title, disabled = false, children }: Props = $props();
const instanceId = $props.id();
const triggerId = `accordion-trigger-${instanceId}`;
const panelId = `accordion-panel-${instanceId}`;
const context = getAccordionContext();
const open = $derived(context.isOpen(value));
</script>

<section class="smrt-accordion-item__root" data-smrt-component="AccordionItem">
  <h3>
    <button id={triggerId} type="button" aria-expanded={open} aria-controls={panelId} {disabled} onclick={() => context.toggle(value)}>
      <span>{title}</span><span class="smrt-accordion-item__chevron" data-smrt-part="indicator" aria-hidden="true">⌄</span>
    </button>
  </h3>
  {#if open}
    <div id={panelId} role="region" aria-labelledby={triggerId} class="smrt-accordion-item__panel" data-smrt-part="panel">{#if children}{@render children()}{/if}</div>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  h3 {
    margin: 0;
  }
  button {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-4);
    cursor: pointer;
  }
  button:disabled {
    cursor: not-allowed;
  }
  .smrt-accordion-item__panel {
    padding: 0 var(--smrt-spacing-4) var(--smrt-spacing-4);
  }
}

@layer smrt.theme {
  .smrt-accordion-item__root {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-accordion-item__root:last-child {
    border-bottom: 0;
  }
  button {
    border: 0;
    background: transparent;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-small-font);
    text-align: left;
  }
  button:hover:not(:disabled) {
    background: var(--smrt-color-surface-container-low);
  }
  button:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: calc(var(--smrt-focus-ring-width) * -1);
  }
  button:disabled {
    opacity: .5;
  }
  .smrt-accordion-item__chevron {
    transition: transform var(--smrt-duration-short4) var(--smrt-easing-standard);
  }
  button[aria-expanded='true'] .smrt-accordion-item__chevron {
    transform: rotate(180deg);
  }
  .smrt-accordion-item__panel {
    color: var(--smrt-color-on-surface-variant);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-accordion-item__chevron {
      transition: none;
    }
  }
}

</style>
