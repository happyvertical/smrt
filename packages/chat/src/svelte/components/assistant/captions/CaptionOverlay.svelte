<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { type Snippet, setContext } from 'svelte';
import { M } from '../../../i18n.js';
import { CAPTION_OVERLAY } from './caption-overlay-context.js';

export interface Props {
  /** Caption components sharing this viewport-bottom group, in reading order. */
  children: Snippet;
  /** Localized accessible name for the caption group. */
  label?: string;
}

let { children, label = 'Captions' }: Props = $props();
const { t } = useI18n();
setContext(CAPTION_OVERLAY, true);
let group: HTMLElement;
let viewport: HTMLDivElement;
let content: HTMLDivElement;
let overflowing = $state(false);
let atStart = $state(true);
let atEnd = $state(false);

function updatePosition() {
  atStart = viewport.scrollTop <= 0;
  atEnd =
    Math.ceil(viewport.scrollTop + viewport.clientHeight) >=
    viewport.scrollHeight;
}

function scroll(direction: number) {
  viewport.scrollBy({
    top: direction * viewport.clientHeight,
    behavior: 'instant',
  });
  updatePosition();
}

$effect(() => {
  // Observe only this owned group. Compare against the group's entire budget,
  // not the viewport reduced by the buttons, so controls disappear when text fits.
  const observer = new ResizeObserver(() => {
    overflowing = content.scrollHeight > group.clientHeight;
    updatePosition();
  });
  observer.observe(group);
  observer.observe(viewport);
  observer.observe(content);
  return () => observer.disconnect();
});
</script>

<section bind:this={group} class="smrt-caption-overlay__root" aria-label={label} data-smrt-component="CaptionOverlay">
  <div bind:this={viewport} class="smrt-caption-overlay__viewport" data-smrt-part="body" onscroll={updatePosition}>
    <div bind:this={content} class="smrt-caption-overlay__list" data-smrt-part="list">
      {@render children()}
    </div>
  </div>
  {#if overflowing}
    <div class="smrt-caption-overlay__controls" data-smrt-part="actions">
      <Button size="sm" disabled={atStart} onclick={() => scroll(-1)}>{t(M['chat.caption_overlay.scroll_up'])}</Button>
      <Button size="sm" disabled={atEnd} onclick={() => scroll(1)}>{t(M['chat.caption_overlay.scroll_down'])}</Button>
    </div>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-caption-overlay__root {
    position: fixed;
    z-index: var(--smrt-z-index-sticky, 1100);
    inset-inline-start: max(var(--smrt-spacing-4, 1rem), env(safe-area-inset-left));
    inset-inline-end: max(var(--smrt-spacing-4, 1rem), env(safe-area-inset-right));
    inset-block-end: max(var(--smrt-spacing-4, 1rem), env(safe-area-inset-bottom));
    box-sizing: border-box;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    max-inline-size: 42rem;
    max-block-size: min(50dvh, calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 2 * var(--smrt-spacing-4, 1rem)));
    margin-inline: auto;
    overflow: hidden;
  }
  .smrt-caption-overlay__root:not(:has(.smrt-caption-overlay__list > *)) {
    display: none;
  }
  .smrt-caption-overlay__viewport {
    min-block-size: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .smrt-caption-overlay__list {
    display: grid;
    gap: var(--smrt-spacing-3, .75rem);
  }
  .smrt-caption-overlay__controls {
    display: flex;
    justify-content: space-between;
    gap: var(--smrt-spacing-3, .75rem);
    padding-block-start: var(--smrt-spacing-2, .5rem);
  }
}

@layer smrt.theme {
  .smrt-caption-overlay__viewport {
    scroll-behavior: auto;
  }
  .smrt-caption-overlay__controls {
    background: var(--smrt-color-surface, Canvas);
  }
}

</style>
