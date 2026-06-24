<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import {
  type ContentBodyFormat,
  extractBodyImages,
  resolveBodyFormat,
} from '../../body-format';
import { M } from '../i18n.editor.js';

const { t } = useI18n();

export interface Props {
  body: string;
  format?: ContentBodyFormat | null;
  selectedIndex?: number;
  onSelect?: (index: number) => void;
}

let {
  body,
  format = null,
  selectedIndex = 0,
  onSelect = undefined,
}: Props = $props();

const resolvedFormat = $derived(resolveBodyFormat(format, body));
const images = $derived(extractBodyImages(body || '', resolvedFormat));
const normalizedIndex = $derived(
  images.length === 0
    ? -1
    : Math.min(Math.max(selectedIndex, 0), images.length - 1),
);
const activeImage = $derived(
  normalizedIndex >= 0 ? images[normalizedIndex] : null,
);
const hasMultiple = $derived(images.length > 1);

function cycle(delta: number) {
  if (!hasMultiple) {
    return;
  }

  const nextIndex = (normalizedIndex + delta + images.length) % images.length;
  onSelect?.(nextIndex);
}
</script>

{#if activeImage}
  <div class="content-image-chooser" aria-label={t(M['content.content_image_chooser.body_images'])}>
    {#if hasMultiple}
      <Button
        variant="ghost"
        size="sm"
        type="button"
        class="chooser-arrow"
        aria-label={t(M['content.content_image_chooser.previous_body_image'])}
        onclick={() => cycle(-1)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </Button>
    {/if}

    <Button
      variant="ghost"
      size="sm"
      type="button"
      class="chooser-preview"
      aria-label={t(M['content.content_image_chooser.focus_selected_body_image'])}
      onclick={() => onSelect?.(normalizedIndex)}
    >
      <img src={activeImage.src} alt={activeImage.alt || 'Body image'} />
      <span>{normalizedIndex + 1} / {images.length}</span>
    </Button>

    {#if hasMultiple}
      <Button
        variant="ghost"
        size="sm"
        type="button"
        class="chooser-arrow"
        aria-label={t(M['content.content_image_chooser.next_body_image'])}
        onclick={() => cycle(1)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </Button>
    {/if}
  </div>
{/if}

<style>
  .content-image-chooser {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 2.75rem;
  }

  .content-image-chooser :global(.chooser-arrow),
  .content-image-chooser :global(.chooser-preview) {
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    border-radius: var(--smrt-radius-full, 9999px);
    cursor: pointer;
  }

  .content-image-chooser :global(.chooser-arrow) {
    width: 2.25rem;
    height: 2.25rem;
    display: grid;
    place-items: center;
    padding: 0;
  }

  .content-image-chooser :global(.chooser-arrow:disabled) {
    cursor: not-allowed;
    opacity: 0.38;
  }

  .content-image-chooser :global(.chooser-preview) {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.25rem 0.65rem 0.25rem 0.3rem;
    font-size: var(--smrt-typography-label-large-size, 0.82rem);
    font-weight: var(--smrt-typography-weight-bold, 650);
  }

  .content-image-chooser :global(.chooser-preview img) {
    width: 2rem;
    height: 2rem;
    border-radius: var(--smrt-radius-full, 9999px);
    object-fit: cover;
    background: var(--smrt-color-surface-container-high);
  }
</style>
