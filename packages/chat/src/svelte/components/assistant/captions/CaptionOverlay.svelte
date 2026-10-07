<script lang="ts">
import { type Snippet, setContext } from 'svelte';
import { CAPTION_OVERLAY } from './caption-overlay-context.js';

export interface Props {
  /** Caption components sharing this viewport-bottom group, in reading order. */
  children: Snippet;
  /** Localized accessible name for the keyboard-scrollable caption group. */
  label?: string;
}

let { children, label = 'Captions' }: Props = $props();
setContext(CAPTION_OVERLAY, true);
</script>

<section class="caption-overlay" aria-label={label} tabindex="0">
  {@render children()}
</section>

<style>
  .caption-overlay {
    position: fixed;
    z-index: var(--smrt-z-index-sticky, 1100);
    inset-inline-start: max(var(--smrt-spacing-4, 1rem), env(safe-area-inset-left));
    inset-inline-end: max(var(--smrt-spacing-4, 1rem), env(safe-area-inset-right));
    inset-block-end: max(var(--smrt-spacing-4, 1rem), env(safe-area-inset-bottom));
    box-sizing: border-box;
    display: grid;
    grid-auto-rows: max-content;
    gap: var(--smrt-spacing-3, .75rem);
    max-inline-size: 42rem;
    max-block-size: min(50dvh, calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 2 * var(--smrt-spacing-4, 1rem)));
    margin-inline: auto;
    overflow: auto;
    overscroll-behavior: contain;
    scroll-behavior: auto;
  }

  .caption-overlay:not(:has(> *)) { display: none; }

  .caption-overlay:focus-visible {
    outline: 2px solid var(--smrt-color-primary, currentColor);
    outline-offset: 2px;
  }
</style>
