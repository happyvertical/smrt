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
  class:closeable
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
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
    border: 1px solid var(--smrt-color-outline-variant, #cac4d0);
    max-width: 100%;
  }

  .chip.sm {
    padding: 0 var(--smrt-spacing-1, 4px);
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
  }
  .chip.md {
    padding: 0 var(--smrt-spacing-2, 8px);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }

  .chip.selected {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    border-color: var(--smrt-color-primary);
  }

  .chip.disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .chip__body {
    appearance: none;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-1, 4px);
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
    padding: var(--smrt-spacing-1, 4px);
    border-radius: var(--smrt-radius-full, 9999px);
    opacity: 0.7;
  }
  .chip__close:hover {
    opacity: 1;
    background: color-mix(in srgb, currentColor 12%, transparent);
  }

  .chip__body:focus-visible,
  .chip__close:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 1px;
  }
</style>
