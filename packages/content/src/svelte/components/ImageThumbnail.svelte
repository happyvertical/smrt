<script lang="ts">
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import { joinApiUrl } from '../api';
import { M } from '../i18n.editor.js';
import {
  getCachedThumbnail,
  setCachedThumbnail,
  THUMBNAIL_FAILURE_TTL_MS,
  type ThumbnailState,
} from './ImageThumbnail.cache';

const { t } = useI18n();

interface ImageThumbnailProps {
  assetId: string;
  apiBaseUrl?: string;
}

let { assetId, apiBaseUrl = '/api/v1' }: ImageThumbnailProps = $props();

let imageUrl: string | null = $state(null);
let thumbnailState: ThumbnailState = $state('loading');
let currentCacheKey: string | null = $state(null);

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }

  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

$effect(() => {
  if (!assetId) {
    currentCacheKey = null;
    imageUrl = null;
    thumbnailState = 'missing';
    return;
  }

  const cacheKey = `${apiBaseUrl}::${assetId}`;
  currentCacheKey = cacheKey;
  const cached = getCachedThumbnail(cacheKey);
  if (cached) {
    imageUrl = cached.url;
    thumbnailState = cached.state;
    return;
  }

  imageUrl = null;
  thumbnailState = 'loading';

  const abortController = new AbortController();

  fetch(joinApiUrl(apiBaseUrl, `/images/${assetId}`), {
    signal: abortController.signal,
  })
    .then((res) => {
      if (!res.ok) {
        return null;
      }

      return res.json();
    })
    .then((data) => {
      imageUrl = data?.sourceUri || data?.url || null;
      thumbnailState = imageUrl ? 'ready' : 'missing';
      setCachedThumbnail(cacheKey, {
        state: thumbnailState,
        url: imageUrl,
        expiresAt: imageUrl ? null : Date.now() + THUMBNAIL_FAILURE_TTL_MS,
      });
    })
    .catch((error: unknown) => {
      if (isAbortError(error, abortController.signal)) {
        return;
      }

      imageUrl = null;
      thumbnailState = 'missing';
      setCachedThumbnail(cacheKey, {
        state: 'missing',
        url: null,
        expiresAt: Date.now() + THUMBNAIL_FAILURE_TTL_MS,
      });
    });

  return () => {
    abortController.abort();
  };
});
</script>

{#if thumbnailState === 'ready' && imageUrl}
  <img
    src={imageUrl}
    alt={t(M['content.image_thumbnail.thumbnail_preview'])}
    class="smrt-thumbnail-img"
    loading="lazy"
    onerror={() => {
      imageUrl = null;
      thumbnailState = 'missing';
      if (currentCacheKey) {
        setCachedThumbnail(currentCacheKey, {
          state: 'missing',
          url: null,
          expiresAt: Date.now() + THUMBNAIL_FAILURE_TTL_MS,
        });
      }
    }}
  />
{:else if thumbnailState === 'loading'}
  <div class="smrt-thumbnail-skeleton" aria-hidden="true"></div>
{:else}
  <div class="smrt-thumbnail-missing" aria-label={t(M['content.image_thumbnail.thumbnail_unavailable'])}>
    <span>{t(M['content.image_thumbnail.preview_unavailable'])}</span>
  </div>
{/if}

<style>
  .smrt-thumbnail-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .smrt-thumbnail-skeleton {
    width: 100%;
    height: 100%;
    background: var(--smrt-color-surface-container-high, #242424);
  }

  .smrt-thumbnail-missing {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 0.75rem;
    background:
      linear-gradient(
        135deg,
        color-mix(in srgb, var(--smrt-color-surface-container-low, #1f2937) 92%, transparent),
        color-mix(in srgb, var(--smrt-color-surface-container-high, #111827) 96%, transparent)
      );
    color: var(--smrt-color-on-surface-variant, #cbd5e1);
    text-align: center;
  }

  .smrt-thumbnail-missing span {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.04em);
    text-transform: uppercase;
  }
</style>
