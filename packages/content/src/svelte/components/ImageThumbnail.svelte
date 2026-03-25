<script lang="ts">
import { joinApiUrl } from '../api';

type ThumbnailState = 'loading' | 'ready' | 'missing';

const thumbnailCache = new Map<
  string,
  {
    state: ThumbnailState;
    url: string | null;
  }
>();

interface ImageThumbnailProps {
  assetId: string;
  apiBaseUrl?: string;
}

let { assetId, apiBaseUrl = '/api/v1' }: ImageThumbnailProps = $props();

let imageUrl: string | null = $state(null);
let thumbnailState: ThumbnailState = $state('loading');

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
    imageUrl = null;
    thumbnailState = 'missing';
    return;
  }

  const cacheKey = `${apiBaseUrl}::${assetId}`;
  const cached = thumbnailCache.get(cacheKey);
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
      thumbnailCache.set(cacheKey, {
        state: thumbnailState,
        url: imageUrl,
      });
    })
    .catch((error: unknown) => {
      if (isAbortError(error, abortController.signal)) {
        return;
      }

      imageUrl = null;
      thumbnailState = 'missing';
      thumbnailCache.set(cacheKey, {
        state: 'missing',
        url: null,
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
    alt="Thumbnail preview"
    class="smrt-thumbnail-img"
    loading="lazy"
    onerror={() => {
      imageUrl = null;
      thumbnailState = 'missing';
      thumbnailCache.set(`${apiBaseUrl}::${assetId}`, {
        state: 'missing',
        url: null,
      });
    }}
  />
{:else if thumbnailState === 'loading'}
  <div class="smrt-thumbnail-skeleton" aria-hidden="true"></div>
{:else}
  <div class="smrt-thumbnail-missing" aria-label="Thumbnail unavailable">
    <span>Preview unavailable</span>
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
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
</style>
