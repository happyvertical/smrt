<script lang="ts">
/**
 * Chip — compact token, optionally selectable (toggle) and/or closeable.
 *
 * When `selectable`, the body is a `<button>` reflecting `selected` via
 * `aria-pressed`. When `closeable`, a labelled remove `<button>` is appended.
 * Both are native buttons, so keyboard activation is built in.
 */
import type { Snippet } from 'svelte';

export type ChipSize = 'sm' | 'md';

export interface Props {
  /** Text label; also the close button's accessible name (`Remove <label>`). */
  label?: string;
  /** Chip content; falls back to `label`. */
  children?: Snippet;
  /** Render the body as a toggle button reflecting `selected`. */
  selectable?: boolean;
  /** Selected state (only meaningful with `selectable`). */
  selected?: boolean;
  /** Append a remove (×) button. */
  closeable?: boolean;
  /** Disable both buttons. */
  disabled?: boolean;
  /** Size variant. */
  size?: ChipSize;
  /** Fired when a selectable chip body is activated. */
  onselect?: () => void;
  /** Fired when the remove button is activated. */
  onclose?: () => void;
}

const {
  label,
  children,
  selectable = false,
  selected = false,
  closeable = false,
  disabled = false,
  size = 'md',
  onselect,
  onclose,
}: Props = $props();
</script>

<span
  class="chip {size}"
  class:selected
  class:disabled
  class:selectable
  class:closeable data-smrt-component="Chip"
>
  {#if selectable}
    <button
      type="button"
      class="chip__body"
      aria-pressed={selected}
      {disabled}
      onclick={() => onselect?.()}
    >
      {#if children}{@render children()}{:else}{label}{/if}
    </button>
  {:else}
    <span class="chip__body">
      {#if children}{@render children()}{:else}{label}{/if}
    </span>
  {/if}

  {#if closeable}
    <button
      type="button"
      class="chip__close"
      aria-label={label ? `Remove ${label}` : 'Remove'}
      {disabled}
      onclick={() => onclose?.()}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  {/if}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
    border-radius: var(--smrt-control-radius);
    background: var(--smrt-surface-control);
    color: var(--smrt-color-on-surface);
    border: var(--smrt-hairline);
    font-weight: var(--smrt-control-weight);
    max-width: 100%;
  }

  /* State layer: currentColor mixed at the theme's state opacity. */
  .chip::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: transparent;
    pointer-events: none;
  }

  .chip.selectable:hover::after {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
  }

  .chip.selectable:active::after {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-pressed) * 100%), transparent);
  }

  .chip.sm {
    padding: 0 var(--smrt-spacing-1);
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
  }
  .chip.sm {
    border-radius: var(--smrt-control-radius-small);
  }
  .chip.md {
    min-block-size: var(--smrt-control-height-small);
    padding: 0 var(--smrt-spacing-2);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }

  .chip.selected {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    border-color: var(--smrt-color-primary);
  }

  .chip.disabled {
    opacity: var(--smrt-state-disabled);
    pointer-events: none;
  }

  .chip__body {
    appearance: none;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    padding: var(--smrt-spacing-1) var(--smrt-spacing-1);
    cursor: default;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chip.selectable .chip__body {
    cursor: pointer;
  }

  .chip__close {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: var(--smrt-spacing-1);
    border-radius: var(--smrt-radius-full);
    opacity: 0.7;
  }
  .chip__close:hover {
    opacity: 1;
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
  }

  .chip__body:focus-visible,
  .chip__close:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
}
</style>
