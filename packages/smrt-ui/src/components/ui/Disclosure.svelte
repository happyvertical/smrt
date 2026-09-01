<script lang="ts">
import type { Snippet } from 'svelte';

export interface Props {
  /** Header text for the disclosure control. */
  title: string;
  /** Whether the disclosure content is visible. */
  open?: boolean;
  /** Blocks opening the disclosure. */
  disabled?: boolean;
  /** The content shown when the disclosure is open. */
  children?: Snippet;
  /** Fired when the open state changes. */
  onopenchange?: (open: boolean) => void;
  /** Additional CSS class names. */
  class?: string;
}

let {
  title,
  open = $bindable(false),
  disabled = false,
  children,
  onopenchange,
  class: className = '',
}: Props = $props();

function handleToggle(event: Event) {
  const next = (event.currentTarget as HTMLDetailsElement).open;
  if (disabled && next) {
    open = false;
    return;
  }
  open = next;
  onopenchange?.(next);
}
</script>

<details class="disclosure {className}" bind:open ontoggle={handleToggle}>
  <summary aria-disabled={disabled} onclick={(event) => disabled && event.preventDefault()}>
    <span>{title}</span><span class="chevron" aria-hidden="true">⌄</span>
  </summary>
  <div class="content">{#if children}{@render children()}{/if}</div>
</details>

<style>
  .disclosure { border-bottom: 1px solid var(--smrt-color-outline-variant); color: var(--smrt-color-on-surface); }
  summary { display: flex; justify-content: space-between; gap: var(--smrt-spacing-3); padding: var(--smrt-spacing-3) 0; font: var(--smrt-typography-title-small-font); cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  summary[aria-disabled='true'] { opacity: .5; cursor: not-allowed; }
  .chevron { transition: transform var(--smrt-duration-short4) var(--smrt-easing-standard); }
  details[open] .chevron { transform: rotate(180deg); }
  .content { padding: 0 0 var(--smrt-spacing-4); color: var(--smrt-color-on-surface-variant); }
  @media (prefers-reduced-motion: reduce) { .chevron { transition: none; } }
</style>
