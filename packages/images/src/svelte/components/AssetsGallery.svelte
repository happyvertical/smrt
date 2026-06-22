<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
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
  } catch (e: any) {
    error = e.message || 'Failed to load images';
  } finally {
    isLoading = false;
  }
}

// Initial load — must be in onMount to avoid SSR fetch errors
onMount(() => loadImages(true));

// Debounce search on filter changes using idiomatic Svelte 5 $effect cleanup
let searchTimeout: ReturnType<typeof setTimeout> | undefined;
$effect(() => {
  // Register reactive deps
  const _q = searchQuery;
  const _o = orientationFilter;
  const _w = minWidth;
  const _h = minHeight;
  return () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadImages(true), 500);
  };
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

<div class="smrt-assets-gallery">
  <div class="gallery-header">
    <h3>{t(M['images.assets_gallery.title'])}</h3>
    
    <div class="toolbar">
      <div class="search-box">
        <input 
          type="search" 
          bind:value={searchQuery}
          placeholder={t(M['images.assets_gallery.search_placeholder'])}
        />
      </div>
      
      <div class="filters">
        <select bind:value={orientationFilter}>
          <option value="all">{t(M['images.assets_gallery.any_orientation'])}</option>
          <option value="landscape">Landscape</option>
          <option value="portrait">Portrait</option>
          <option value="square">Square</option>
        </select>
        
        <input 
          type="number" 
          bind:value={minWidth}
          placeholder={t(M['images.assets_gallery.min_width_placeholder'])}
          class="size-input"
        />
        <input 
          type="number" 
          bind:value={minHeight}
          placeholder={t(M['images.assets_gallery.min_height_placeholder'])}
          class="size-input"
        />
      </div>
    </div>
  </div>
  
  {#if error}
    <div class="error-msg">{error}</div>
  {/if}
  
  <div class="gallery-grid">
    {#each images as image (image.id)}
      {#if onSelect}
        <button
          type="button"
          class="gallery-item"
          class:selectable={true}
          draggable={enableDragToEditor}
          ondragstart={(event) => handleDragStart(event, image)}
          onclick={() => handleSelect(image)}
        >
          <div class="img-container">
            <img src={image.sourceUri || image.url} alt={image.alt || image.name} loading="lazy" />
          </div>
          <div class="item-info">
            <span class="item-name" title={image.name}>{image.name}</span>
            <span class="item-meta">{image.width}x{image.height} • {image.mimeType}</span>
          </div>
        </button>
      {:else}
        <div class="gallery-item">
          <div class="img-container">
            <img src={image.sourceUri || image.url} alt={image.alt || image.name} loading="lazy" />
          </div>
          <div class="item-info">
            <span class="item-name" title={image.name}>{image.name}</span>
            <span class="item-meta">{image.width}x{image.height} • {image.mimeType}</span>
          </div>
        </div>
      {/if}
    {/each}
    
    {#if images.length === 0 && !isLoading}
      <div class="empty-state">
        <p>{t(M['images.assets_gallery.no_images_found'])}</p>
      </div>
    {/if}
  </div>
  
  {#if hasMore}
    <div class="load-more">
      <button 
        onclick={() => loadImages(false)} 
        disabled={isLoading}
        class="load-more-btn"
      >
        {isLoading ? 'Loading...' : 'Load More'}
      </button>
    </div>
  {/if}
</div>

<style>
  .smrt-assets-gallery {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    height: 100%;
    min-height: 400px;
    background: var(--smrt-color-surface, #121212);
    color: var(--smrt-color-on-surface, #fff);
  }

  .gallery-header {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    background: var(--smrt-color-surface-container, #1a1a1a);
    border-radius: var(--smrt-radius-lg, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #333);
  }

  .gallery-header h3 {
    margin: 0;
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: center;
    justify-content: space-between;
  }

  .search-box {
    flex: 1;
    min-width: 250px;
  }

  .search-box input {
    width: 100%;
    padding: 0.75rem 1.25rem;
    background: var(--smrt-color-surface-container-highest, #333);
    border: 1px solid var(--smrt-color-outline-variant, #444);
    border-radius: var(--smrt-radius-full, 9999px);
    color: inherit;
    font-size: var(--smrt-typography-body-large-size, 0.95rem);
    transition: box-shadow 0.2s, border-color 0.2s;
  }

  .search-box input:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #3b82f6);
    box-shadow: inset 0 0 0 1px var(--smrt-color-primary, #3b82f6);
  }

  .filters {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .filters select, .filters input {
    padding: 0.75rem 1rem;
    background: var(--smrt-color-surface-container-high, #242424);
    border: 1px solid var(--smrt-color-outline-variant, #444);
    border-radius: var(--smrt-radius-sm, 4px);
    color: inherit;
    transition: box-shadow 0.2s, border-color 0.2s;
  }

  .filters select:focus, .filters input:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #3b82f6);
    box-shadow: inset 0 0 0 1px var(--smrt-color-primary, #3b82f6);
  }

  .size-input {
    width: 120px;
  }

  .error-msg {
    color: var(--smrt-color-error, #ef4444);
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    padding: 1rem;
    border-radius: var(--smrt-radius-md, 8px);
  }

  .gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1rem;
    overflow-y: auto;
    padding: 0.25rem;
  }

  .gallery-item {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: 0;
    background: var(--smrt-color-surface-container, #1a1a1a);
    border-radius: var(--smrt-radius-lg, 8px);
    border: 1px solid var(--smrt-color-surface-container-high, #2a2a2a);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px color-mix(in srgb, var(--smrt-color-shadow) 12%, transparent), 0 1px 2px color-mix(in srgb, var(--smrt-color-shadow) 24%, transparent));
    overflow: hidden;
    color: inherit;
    text-align: left;
    transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
  }

  .gallery-item.selectable {
    cursor: pointer;
  }

  .gallery-item.selectable:hover, .gallery-item.selectable:focus {
    transform: translateY(-2px);
    border-color: var(--smrt-color-primary, #3b82f6);
    box-shadow: var(--smrt-elevation-2, 0 3px 6px color-mix(in srgb, var(--smrt-color-shadow) 16%, transparent), 0 3px 6px color-mix(in srgb, var(--smrt-color-shadow) 23%, transparent));
    outline: none;
  }

  .img-container {
    aspect-ratio: 1;
    width: 100%;
    background: var(--smrt-color-surface-container-high, #242424);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .img-container img {
    max-width: 100%;
    max-height: 100%;
    object-fit: cover;
    width: 100%;
    height: 100%;
  }

  .item-info {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .item-name {
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-size: var(--smrt-typography-title-medium-size, 1rem);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: var(--smrt-typography-title-medium-tracking, 0.1px);
  }

  .item-meta {
    font-size: var(--smrt-typography-label-large-size, 0.85rem);
    color: var(--smrt-color-outline, #888);
  }

  .empty-state {
    grid-column: 1 / -1;
    text-align: center;
    padding: 3rem;
    color: var(--smrt-color-outline, #888);
    background: var(--smrt-color-surface-container, #1a1a1a);
    border-radius: var(--smrt-radius-lg, 8px);
    border: 1px dashed var(--smrt-color-outline-variant, #444);
  }

  .load-more {
    display: flex;
    justify-content: center;
    padding: 1rem 0;
  }

  .load-more-btn {
    padding: 0.75rem 2rem;
    background: var(--smrt-color-surface-container-high, #242424);
    color: var(--smrt-color-primary, #3b82f6);
    border: 1px solid var(--smrt-color-outline-variant, #444);
    border-radius: var(--smrt-radius-full, 9999px);
    font-weight: var(--smrt-typography-weight-medium, 500);
    cursor: pointer;
    transition: background 0.2s;
  }

  .load-more-btn:hover:not(:disabled) {
    background: var(--smrt-color-surface-container-highest, #333);
  }

  .load-more-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
