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

<a class="smrt-link-preview__root" href={url} target="_blank" rel="noopener noreferrer" data-smrt-component="LinkPreview">
  {#if imageUrl}
    <div class="smrt-link-preview__image" data-smrt-part="media">
      <img src={imageUrl} alt={title ?? ''} />
    </div>
  {/if}
  <div class="smrt-link-preview__body" data-smrt-part="body">
    {#if title}
      <span class="smrt-link-preview__title" data-smrt-part="title">{title}</span>
    {/if}
    {#if description}
      <span class="smrt-link-preview__description" data-smrt-part="message">{description}</span>
    {/if}
    <span class="smrt-link-preview__domain" data-smrt-part="meta">{hostname}</span>
  </div>
</a>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-link-preview__root {
    display: flex;
    overflow: hidden;
    max-width: 360px;
  }
  .smrt-link-preview__image {
    width: 80px;
    min-height: 60px;
    flex-shrink: 0;
    overflow: hidden;
  }
  .smrt-link-preview__image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .smrt-link-preview__body {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding: var(--smrt-spacing-2, 0.375rem) var(--smrt-spacing-3, 0.75rem);
    min-width: 0;
    overflow: hidden;
  }
  .smrt-link-preview__title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-link-preview__description {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
}

@layer smrt.theme {
  .smrt-link-preview__root {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    text-decoration: none;
    color: inherit;
    transition: box-shadow var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-link-preview__root:hover {
    box-shadow: var(--smrt-elevation-1, 0 1px 3px rgba(0, 0, 0, 0.12));
  }
  .smrt-link-preview__image {
    background: var(--smrt-color-surface-container);
  }
  .smrt-link-preview__title {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-link-preview__description {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-link-preview__domain {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    color: var(--smrt-color-outline);
  }
}

</style>
