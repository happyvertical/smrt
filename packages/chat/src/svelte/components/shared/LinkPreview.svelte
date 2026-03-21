<script lang="ts">
/**
 * LinkPreview - URL preview card
 * Compact card with thumbnail, title, and description.
 */

export interface Props {
  /** The URL being previewed */
  url: string;
  /** Title of the linked page */
  title?: string;
  /** Description of the linked page */
  description?: string;
  /** Preview thumbnail image URL */
  imageUrl?: string;
}

const { url, title, description, imageUrl }: Props = $props();

const hostname = $derived.by(() => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
});
</script>

<a class="link-preview" href={url} target="_blank" rel="noopener noreferrer">
  {#if imageUrl}
    <div class="link-preview__image">
      <img src={imageUrl} alt={title ?? ''} />
    </div>
  {/if}
  <div class="link-preview__body">
    {#if title}
      <span class="link-preview__title">{title}</span>
    {/if}
    {#if description}
      <span class="link-preview__description">{description}</span>
    {/if}
    <span class="link-preview__domain">{hostname}</span>
  </div>
</a>

<style>
  .link-preview {
    display: flex;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    overflow: hidden;
    text-decoration: none;
    color: inherit;
    max-width: 360px;
    transition: box-shadow var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .link-preview:hover {
    box-shadow: var(--smrt-elevation-level1, 0 1px 3px rgba(0, 0, 0, 0.12));
  }

  .link-preview__image {
    width: 80px;
    min-height: 60px;
    flex-shrink: 0;
    overflow: hidden;
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .link-preview__image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .link-preview__body {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding: var(--smrt-spacing-2, 0.375rem) var(--smrt-spacing-3, 0.75rem);
    min-width: 0;
    overflow: hidden;
  }

  .link-preview__title {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: 500;
    color: var(--smrt-color-on-surface, #1b1b1f);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .link-preview__description {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .link-preview__domain {
    font-size: 0.6875rem;
    color: var(--smrt-color-outline, #74777f);
  }
</style>
