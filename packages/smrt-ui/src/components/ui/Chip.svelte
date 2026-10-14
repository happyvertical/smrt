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
  class="smrt-chip__root smrt-chip__{size}"
  class:smrt-chip__selected={selected}
  class:smrt-chip__disabled={disabled}
  class:smrt-chip__selectable={selectable}
  class:smrt-chip__closeable={closeable} data-smrt-component="Chip"
>
  {#if selectable}
    <button
      type="button"
      class="smrt-chip__body" data-smrt-part="body"
      aria-pressed={selected}
      {disabled}
      onclick={() => onselect?.()}
    >
      {#if children}{@render children()}{:else}{label}{/if}
    </button>
  {:else}
    <span class="smrt-chip__body" data-smrt-part="body">
      {#if children}{@render children()}{:else}{label}{/if}
    </span>
  {/if}

  {#if closeable}
    <button
      type="button"
      class="smrt-chip__close" data-smrt-part="close"
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
@layer smrt.structure {
  .smrt-chip__root {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
    max-width: 100%;
  }
  .smrt-chip__root::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .smrt-chip__root.smrt-chip__sm {
    padding: 0 var(--smrt-spacing-1);
  }
  .smrt-chip__root.smrt-chip__md {
    min-block-size: var(--smrt-control-height-small);
    padding: 0 var(--smrt-spacing-2);
  }
  .smrt-chip__root.smrt-chip__disabled {
    pointer-events: none;
  }
  .smrt-chip__body {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-1);
    cursor: default;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-chip__root.smrt-chip__selectable .smrt-chip__body {
    cursor: pointer;
  }
  .smrt-chip__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: var(--smrt-spacing-1);
  }
}
@layer smrt.theme {
  .smrt-chip__root {
    border-radius: var(--smrt-control-radius);
    background: var(--smrt-surface-control);
    color: var(--smrt-color-on-surface);
    border: var(--smrt-hairline);
    font-weight: var(--smrt-control-weight);
  }
  .smrt-chip__root::after {
    border-radius: inherit;
    background: transparent;
  }
  .smrt-chip__root.smrt-chip__selectable:hover::after {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
  }
  .smrt-chip__root.smrt-chip__selectable:active::after {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-pressed) * 100%), transparent);
  }
  .smrt-chip__root.smrt-chip__sm {
    font-size: var(--smrt-typography-label-small-size);
  }
  .smrt-chip__root.smrt-chip__sm {
    border-radius: var(--smrt-control-radius-small);
  }
  .smrt-chip__root.smrt-chip__md {
    font-size: var(--smrt-typography-label-large-size);
  }
  .smrt-chip__root.smrt-chip__selected {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    border-color: var(--smrt-color-primary);
  }
  .smrt-chip__root.smrt-chip__disabled {
    opacity: var(--smrt-state-disabled);
  }
  .smrt-chip__body {
    appearance: none;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
  }
  .smrt-chip__close {
    appearance: none;
    background: none;
    border: none;
    color: inherit;
    border-radius: var(--smrt-radius-full);
    opacity: 0.7;
  }
  .smrt-chip__close:hover {
    opacity: 1;
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
  }
  .smrt-chip__body:focus-visible,
  .smrt-chip__close:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  /* Forced colors (#3908): system colours where colour alone carries meaning. */
  @media (forced-colors: active) {
    .smrt-chip__root.smrt-chip__selected { border-color: Highlight; outline: var(--smrt-focus-ring-width) solid Highlight; outline-offset: calc(-1 * var(--smrt-focus-ring-width)); }
    .smrt-chip__root.smrt-chip__disabled, .smrt-chip__root.smrt-chip__selected.smrt-chip__disabled { opacity: 1; color: GrayText; border-color: GrayText; outline-color: GrayText; }
  }
}
</style>
