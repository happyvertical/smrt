<script lang="ts">
import {
  type ContentBodyFormat,
  renderContentBodyHtml,
  resolveBodyFormat,
} from '../../body-format';

export interface Props {
  /** The body content to render as HTML or Markdown. */
  content: string;
  /** Format of the content: HTML, Markdown, or auto-detected if null. */
  format?: ContentBodyFormat | null;
  /** CSS class to apply to the rendered container. */
  class?: string;
  /** Replace the thumbnail block's image URL (see `renderContentBodyHtml`). */
  thumbnailSrc?: string | null;
}

let {
  content,
  format = null,
  class: className = '',
  thumbnailSrc = null,
}: Props = $props();

const resolvedFormat = $derived(resolveBodyFormat(format, content));
// Both formats render through the same sanitizer and into the same container,
// so image placements (header, wrap left/right) look identical whichever
// format the body was saved in.
const safeHtml = $derived(
  renderContentBodyHtml(content || '', resolvedFormat, { thumbnailSrc }),
);
</script>

<div
  class="smrt-content-body-renderer__root {resolvedFormat === 'markdown' ? 'markdown-content' : ''} {className}" data-smrt-component="ContentBodyRenderer"
>
  {@html safeHtml}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-content-body-renderer__root :global(h1) {
    margin: var(--smrt-spacing-2xl, 2rem) 0 var(--smrt-spacing-lg, 1rem);
  }
  .smrt-content-body-renderer__root :global(h2) {
    margin: var(--smrt-spacing-xl, 1.5rem) 0 var(--smrt-spacing-md, 0.75rem);
  }
  .smrt-content-body-renderer__root :global(h3) {
    margin: var(--smrt-spacing-lg, 1rem) 0 var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-content-body-renderer__root :global(p) {
    margin: var(--smrt-spacing-md, 0.75rem) 0;
  }
  .smrt-content-body-renderer__root :global(p:first-child) {
    margin-top: 0;
  }
  .smrt-content-body-renderer__root :global(p:last-child) {
    margin-bottom: 0;
  }
  .smrt-content-body-renderer__root::after {
    display: block;
    clear: both;
    content: '';
  }
  .smrt-content-body-renderer__root :global(ul),
  .smrt-content-body-renderer__root :global(ol) {
    margin: var(--smrt-spacing-md, 0.75rem) 0;
    padding-left: var(--smrt-spacing-xl, 1.5rem);
  }
  .smrt-content-body-renderer__root :global(img) {
    display: block;
    width: var(--smrt-content-body-image-width, min(100%, 48rem));
    height: auto;
    margin: var(--smrt-spacing-lg, 1rem) 0;
  }
  .smrt-content-body-renderer__root :global(figure[data-smrt-inline-image]) {
    display: block;
    width: var(--smrt-content-body-image-width, min(100%, 32rem));
    max-width: 100%;
    margin: var(--smrt-spacing-lg, 1rem) 0;
  }
  .smrt-content-body-renderer__root :global(figure[data-smrt-inline-image] img) {
    width: 100%;
    max-width: 100%;
    margin: 0;
  }
  .smrt-content-body-renderer__root :global(figure[data-smrt-placement='left']),
  .smrt-content-body-renderer__root :global(img[data-smrt-placement='left']) {
    float: left;
    width: var(--smrt-content-body-image-width, min(45%, 22rem));
    margin: 0.35rem var(--smrt-spacing-lg, 1rem) var(--smrt-spacing-sm, 0.5rem) 0;
  }
  .smrt-content-body-renderer__root :global(figure[data-smrt-placement='right']),
  .smrt-content-body-renderer__root :global(img[data-smrt-placement='right']) {
    float: right;
    width: var(--smrt-content-body-image-width, min(45%, 22rem));
    margin: 0.35rem 0 var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-lg, 1rem);
  }
  .smrt-content-body-renderer__root :global(figure[data-smrt-placement='center']),
  .smrt-content-body-renderer__root :global(figure[data-smrt-placement='block']),
  .smrt-content-body-renderer__root :global(img[data-smrt-placement='center']),
  .smrt-content-body-renderer__root :global(img[data-smrt-placement='block']) {
    float: none;
    display: block;
    margin-left: auto;
    margin-right: auto;
  }
  .smrt-content-body-renderer__root :global(figure[data-smrt-placement='full']),
  .smrt-content-body-renderer__root :global(img[data-smrt-placement='full']),
  .smrt-content-body-renderer__root :global(img[data-smrt-inline-image][data-smrt-placement='full']) {
    float: none;
    width: 100%;
    max-width: 100%;
    margin-left: 0;
    margin-right: 0;
    clear: both;
  }
  .smrt-content-body-renderer__root :global(img[data-smrt-inline-image]) {
    width: var(--smrt-content-body-image-width, min(100%, 32rem));
    max-width: 100%;
  }
  .smrt-content-body-renderer__root :global(img[data-smrt-inline-image][data-smrt-placement='left']),
  .smrt-content-body-renderer__root :global(img[data-smrt-inline-image][data-smrt-placement='right']) {
    width: var(--smrt-content-body-image-width, min(45%, 22rem));
  }
  .smrt-content-body-renderer__root :global(img[data-smrt-thumbnail][data-smrt-placement='right']) {
    margin-top: 0.25rem;
  }
  /* Phones: wrapped images stack full width above the text they sat beside. */
  @media (max-width: 36rem) {
    .smrt-content-body-renderer__root :global(figure[data-smrt-placement='left']),
    .smrt-content-body-renderer__root :global(figure[data-smrt-placement='right']),
    .smrt-content-body-renderer__root :global(img[data-smrt-placement='left']),
    .smrt-content-body-renderer__root :global(img[data-smrt-placement='right']),
    .smrt-content-body-renderer__root :global(img[data-smrt-inline-image][data-smrt-placement='left']),
    .smrt-content-body-renderer__root :global(img[data-smrt-inline-image][data-smrt-placement='right']) {
      float: none;
      width: 100%;
      margin: var(--smrt-spacing-md, 0.75rem) 0;
    }
  }
}

@layer smrt.theme {
  .smrt-content-body-renderer__root {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: var(--smrt-typography-body-large-line-height, 1.5);
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-body-renderer__root :global(h1),
  .smrt-content-body-renderer__root :global(h2),
  .smrt-content-body-renderer__root :global(h3) {
    color: var(--smrt-color-on-surface);
    line-height: 1.2;
  }
  .smrt-content-body-renderer__root :global(h1) {
    font-size: var(--smrt-typography-headline-large-size, 2rem);
  }
  .smrt-content-body-renderer__root :global(h2) {
    font-size: var(--smrt-typography-headline-medium-size, 1.75rem);
  }
  .smrt-content-body-renderer__root :global(h3) {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
  }
  .smrt-content-body-renderer__root :global(a) {
    color: var(--smrt-color-primary);
    text-decoration: underline;
    text-underline-offset: 0.18em;
  }
  .smrt-content-body-renderer__root :global(img) {
    border-radius: var(--smrt-radius-medium);
  }
}

</style>
