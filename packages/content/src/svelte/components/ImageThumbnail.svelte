<script lang="ts">
import { joinApiUrl } from '../api';

interface ImageThumbnailProps {
  assetId: string;
  apiBaseUrl?: string;
}

let { assetId, apiBaseUrl = '/api/v1' }: ImageThumbnailProps = $props();

let imageUrl: string | null = $state(null);

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
    return;
  }

  imageUrl = null;

  const abortController = new AbortController();

  fetch(joinApiUrl(apiBaseUrl, `/images/${assetId}`), {
    signal: abortController.signal,
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      imageUrl = data?.sourceUri || data?.url || null;
    })
    .catch((error: unknown) => {
      if (isAbortError(error, abortController.signal)) {
        return;
      }

      imageUrl = null;
    });

  return () => {
    abortController.abort();
  };
});
</script>

{#if imageUrl}
  <img src={imageUrl} alt="Thumbnail preview" class="smrt-thumbnail-img" />
{:else}
  <div class="smrt-thumbnail-skeleton"></div>
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
</style>
