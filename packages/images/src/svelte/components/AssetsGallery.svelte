<script lang="ts">
import { Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import { M } from '../i18n.js';
import type {
  ImageLike,
  ImagesGalleryClient,
  ImagesGalleryQuery,
} from '../image-clients';

const { t } = useI18n();

let {
  apiBaseUrl = '/api/v1',
  client = undefined,
  onSelect = undefined,
  enableDragToEditor = false,
}: {
  apiBaseUrl?: string;
  client?: ImagesGalleryClient;
  onSelect?: (image: ImageLike) => void;
  enableDragToEditor?: boolean;
} = $props();

let images: ImageLike[] = $state([]);
let isLoading = $state(false);
let error: string | null = $state(null);

// Filters
let searchQuery = $state('');
let orientationFilter: 'all' | 'landscape' | 'portrait' | 'square' =
  $state('all');
let minWidth = $state('');
let minHeight = $state('');

// Pagination (simple implementation for now)
let limit = 24;
let offset = $state(0);
let hasMore = $state(true);

async function loadImagesFromApi(query: ImagesGalleryQuery) {
  const params = new URLSearchParams({
    limit: query.limit.toString(),
    offset: query.offset.toString(),
  });

  if (query.q) params.append('q', query.q);
  if (query.orientation) params.append('orientation', query.orientation);
  if (typeof query.minWidth === 'number') {
    params.append('minWidth', query.minWidth.toString());
  }
  if (typeof query.minHeight === 'number') {
    params.append('minHeight', query.minHeight.toString());
  }

  const res = await fetch(`${apiBaseUrl}/images?${params.toString()}`);
  if (!res.ok) {
    let errText = await res.text();
    if (errText.trim().startsWith('<'))
      errText = `Server returned ${res.status} ${res.statusText}`;
    throw new Error(errText);
  }

  return (await res.json()) as { items: ImageLike[] };
}

async function loadImages(reset = false) {
  if (isLoading) return;

  if (reset) {
    images = [];
    offset = 0;
    hasMore = true;
  }

  if (!hasMore && !reset) return;

  isLoading = true;
  error = null;

  try {
    const query: ImagesGalleryQuery = {
      limit,
      offset,
      ...(searchQuery ? { q: searchQuery } : {}),
      ...(orientationFilter !== 'all'
        ? { orientation: orientationFilter }
        : {}),
      ...(minWidth ? { minWidth: Number(minWidth) } : {}),
      ...(minHeight ? { minHeight: Number(minHeight) } : {}),
    };
    const data = client
      ? await client.list(query)
      : await loadImagesFromApi(query);

    if (data.items.length < limit) {
      hasMore = false;
    }

    images = [...images, ...data.items];
    offset += data.items.length;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to load images';
  } finally {
    isLoading = false;
  }
}

// Initial load — must be in onMount to avoid SSR fetch errors
onMount(() => loadImages(true));

// Debounce search on filter changes. Schedule the timer in the effect *body*
// (not the cleanup) and clear it in the returned cleanup, so a pending reload
// is cancelled — never fired — when the component unmounts. Skip the very first
// run because onMount() already performs the initial load.
let didInitialFilterRun = false;
$effect(() => {
  // Register reactive deps
  const _q = searchQuery;
  const _o = orientationFilter;
  const _w = minWidth;
  const _h = minHeight;

  if (!didInitialFilterRun) {
    didInitialFilterRun = true;
    return;
  }

  const id = setTimeout(() => loadImages(true), 500);
  return () => clearTimeout(id);
});

function handleSelect(image: ImageLike) {
  if (onSelect) {
    onSelect(image);
  }
}

function handleDragStart(event: DragEvent, image: ImageLike) {
  if (!enableDragToEditor || !event.dataTransfer) {
    return;
  }

  const source = image.sourceUri || image.url || '';
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/x-smrt-image', JSON.stringify(image));
  if (source) {
    event.dataTransfer.setData('text/uri-list', source);
    event.dataTransfer.setData('text/plain', source);
  }
}
</script>

<div class="smrt-assets-gallery__root" data-smrt-component="AssetsGallery">
  <div class="smrt-assets-gallery__header" data-smrt-part="header">
    <h3>{t(M['images.assets_gallery.title'])}</h3>
    
    <div class="smrt-assets-gallery__toolbar" data-smrt-part="toolbar">
      <div class="smrt-assets-gallery__search" data-smrt-part="field">
        <Input
          type="search"
          bind:value={searchQuery}
          placeholder={t(M['images.assets_gallery.search_placeholder'])}
        />
      </div>

      <div class="smrt-assets-gallery__filters" data-smrt-part="group">
        <Select class="smrt-assets-gallery__orientation" bind:value={orientationFilter}>
          <option value="all">{t(M['images.assets_gallery.any_orientation'])}</option>
          <option value="landscape">Wide</option>
          <option value="portrait">Tall</option>
          <option value="square">Square</option>
        </Select>

        <Input
          type="number"
          bind:value={minWidth}
          placeholder={t(M['images.assets_gallery.min_width_placeholder'])}
          class="smrt-assets-gallery__size-input"
        />
        <Input
          type="number"
          bind:value={minHeight}
          placeholder={t(M['images.assets_gallery.min_height_placeholder'])}
          class="smrt-assets-gallery__size-input"
        />
      </div>
    </div>
  </div>
  
  {#if error}
    <div class="smrt-assets-gallery__error" data-smrt-part="error">{error}</div>
  {/if}
  
  <div class="smrt-assets-gallery__grid" data-smrt-part="list">
    {#each images as image (image.id)}
      {#if onSelect}
        <!-- raw-primitive-allow: large draggable selection card wrapping rich image content, not a standard action button -->
        <button
          type="button"
          class="smrt-assets-gallery__item"
          class:smrt-assets-gallery__selectable={true}
          draggable={enableDragToEditor}
          ondragstart={(event) => handleDragStart(event, image)}
          onclick={() => handleSelect(image)}
          data-smrt-part="item"
        >
          <div class="smrt-assets-gallery__thumbnail" data-smrt-part="thumbnail">
            <img src={image.sourceUri || image.url} alt={image.alt || image.name} loading="lazy" />
          </div>
          <div class="smrt-assets-gallery__details" data-smrt-part="details">
            <span class="smrt-assets-gallery__name" data-smrt-part="title" title={image.name}>{image.name}</span>
            <span class="smrt-assets-gallery__meta" data-smrt-part="meta">{image.width} × {image.height}</span>
          </div>
        </button>
      {:else}
        <div class="smrt-assets-gallery__item" data-smrt-part="item">
          <div class="smrt-assets-gallery__thumbnail" data-smrt-part="thumbnail">
            <img src={image.sourceUri || image.url} alt={image.alt || image.name} loading="lazy" />
          </div>
          <div class="smrt-assets-gallery__details" data-smrt-part="details">
            <span class="smrt-assets-gallery__name" data-smrt-part="title" title={image.name}>{image.name}</span>
            <span class="smrt-assets-gallery__meta" data-smrt-part="meta">{image.width} × {image.height}</span>
          </div>
        </div>
      {/if}
    {/each}
    
    {#if images.length === 0 && !isLoading}
      <div class="smrt-assets-gallery__empty" data-smrt-part="empty">
        <p>{t(M['images.assets_gallery.no_images_found'])}</p>
      </div>
    {/if}
  </div>
  
  {#if hasMore}
    <div class="smrt-assets-gallery__load-more" data-smrt-part="actions">
      <Button
        variant="ghost"
        class="smrt-assets-gallery__load-more-button"
        onclick={() => loadImages(false)}
        disabled={isLoading}
      >
        {isLoading ? 'Loading...' : 'Load More'}
      </Button>
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-assets-gallery__root {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    height: 100%;
    min-height: 400px;
  }
  .smrt-assets-gallery__header {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
  }
  .smrt-assets-gallery__header h3 {
    margin: 0;
  }
  .smrt-assets-gallery__toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: center;
    justify-content: space-between;
  }
  .smrt-assets-gallery__search {
    flex: 1;
    min-width: 250px;
  }
  .smrt-assets-gallery__filters {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  /* Layout-only overrides for the migrated filter primitives. The Input / Select
  primitives own the visual styling; these :global() rules only pierce their
  rendered controls to size the boxes within the flex row (see #1589 scoping
  rule). The orientation Select sizes to its content instead of the primitive's
  full-width default; the min-width/min-height Inputs are capped. */
  .smrt-assets-gallery__filters :global(.smrt-assets-gallery__orientation) {
    width: auto;
  }
  .smrt-assets-gallery__filters :global(.smrt-assets-gallery__size-input) {
    width: 120px;
  }
  .smrt-assets-gallery__error {
    padding: 1rem;
  }
  .smrt-assets-gallery__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1rem;
    overflow-y: auto;
    padding: 0.25rem;
  }
  .smrt-assets-gallery__item {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: 0;
    overflow: hidden;
  }
  .smrt-assets-gallery__item.smrt-assets-gallery__selectable {
    cursor: pointer;
  }
  .smrt-assets-gallery__thumbnail {
    aspect-ratio: 1;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .smrt-assets-gallery__thumbnail img {
    max-width: 100%;
    max-height: 100%;
    object-fit: cover;
    width: 100%;
    height: 100%;
  }
  .smrt-assets-gallery__details {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .smrt-assets-gallery__name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-assets-gallery__empty {
    grid-column: 1 / -1;
    padding: 3rem;
  }
  .smrt-assets-gallery__load-more {
    display: flex;
    justify-content: center;
    padding: 1rem 0;
  }
  /* Bespoke pill look for the migrated Load More Button. :global() pierces into
  the Button child's rendered <button>, which carries its own scope hash
  (see #1589 scoping rule). */
  .smrt-assets-gallery__load-more :global(.smrt-assets-gallery__load-more-button) {
    padding: 0.75rem 2rem;
  }
}

@layer smrt.theme {
  .smrt-assets-gallery__root {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-assets-gallery__header {
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-lg);
    border: var(--smrt-hairline);
  }
  .smrt-assets-gallery__header h3 {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
  }
  .smrt-assets-gallery__error {
    color: var(--smrt-color-error);
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-assets-gallery__item {
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-lg);
    border: 1px solid var(--smrt-color-surface-container-high);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px color-mix(in srgb, var(--smrt-color-shadow) 12%, transparent), 0 1px 2px color-mix(in srgb, var(--smrt-color-shadow) 24%, transparent));
    color: inherit;
    text-align: left;
    transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
  }
  .smrt-assets-gallery__item.smrt-assets-gallery__selectable:hover, .smrt-assets-gallery__item.smrt-assets-gallery__selectable:focus {
    transform: translateY(-2px);
    border-color: var(--smrt-color-primary);
    box-shadow: var(--smrt-elevation-2, 0 3px 6px color-mix(in srgb, var(--smrt-color-shadow) 16%, transparent), 0 3px 6px color-mix(in srgb, var(--smrt-color-shadow) 23%, transparent));
    outline: none;
  }
  .smrt-assets-gallery__thumbnail {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-assets-gallery__name {
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-size: var(--smrt-typography-title-medium-size, 1rem);
    letter-spacing: var(--smrt-typography-title-medium-tracking);
  }
  .smrt-assets-gallery__meta {
    font-size: var(--smrt-typography-label-large-size, 0.85rem);
    color: var(--smrt-color-outline);
  }
  .smrt-assets-gallery__empty {
    text-align: center;
    color: var(--smrt-color-outline);
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-lg);
    border: 1px dashed var(--smrt-color-outline-variant);
  }
  /* Bespoke pill look for the migrated Load More Button. :global() pierces into
  the Button child's rendered <button>, which carries its own scope hash
  (see #1589 scoping rule). */
  .smrt-assets-gallery__load-more :global(.smrt-assets-gallery__load-more-button) {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-primary);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-full);
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: background 0.2s;
  }
  .smrt-assets-gallery__load-more :global(.smrt-assets-gallery__load-more-button:hover:not(:disabled)) {
    background: var(--smrt-color-surface-container-highest);
  }
}
</style>
