<script lang="ts">
import {
  type ContentBodyFormat,
  resolveBodyFormat,
  sanitizeHtml,
} from '../../body-format';
import Markdown from './Markdown.svelte';

export interface Props {
  content: string;
  format?: ContentBodyFormat | null;
  class?: string;
}

let { content, format = null, class: className = '' }: Props = $props();

const resolvedFormat = $derived(resolveBodyFormat(format, content));
const safeHtml = $derived(sanitizeHtml(content || ''));
</script>

{#if resolvedFormat === 'markdown'}
  <Markdown {content} class={className} />
{:else}
  <div class="content-body-renderer {className}">
    {@html safeHtml}
  </div>
{/if}

<style>
  .content-body-renderer {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: var(--smrt-typography-body-large-line-height, 1.5);
    color: var(--smrt-color-on-surface);
  }

  .content-body-renderer :global(h1),
  .content-body-renderer :global(h2),
  .content-body-renderer :global(h3) {
    color: var(--smrt-color-on-surface);
    line-height: 1.2;
  }

  .content-body-renderer :global(h1) {
    font-size: var(--smrt-typography-headline-large-size, 2rem);
    margin: var(--spacing-2xl, 2rem) 0 var(--spacing-lg, 1rem);
  }

  .content-body-renderer :global(h2) {
    font-size: var(--smrt-typography-headline-medium-size, 1.75rem);
    margin: var(--spacing-xl, 1.5rem) 0 var(--spacing-md, 0.75rem);
  }

  .content-body-renderer :global(h3) {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    margin: var(--spacing-lg, 1rem) 0 var(--spacing-sm, 0.5rem);
  }

  .content-body-renderer :global(p) {
    margin: var(--spacing-md, 0.75rem) 0;
  }

  .content-body-renderer :global(p:first-child) {
    margin-top: 0;
  }

  .content-body-renderer :global(p:last-child) {
    margin-bottom: 0;
  }

  .content-body-renderer::after {
    content: '';
    display: block;
    clear: both;
  }

  .content-body-renderer :global(ul),
  .content-body-renderer :global(ol) {
    margin: var(--spacing-md, 0.75rem) 0;
    padding-left: var(--spacing-xl, 1.5rem);
  }

  .content-body-renderer :global(a) {
    color: var(--smrt-color-primary);
    text-decoration: underline;
    text-underline-offset: 0.18em;
  }

  .content-body-renderer :global(img) {
    display: block;
    width: min(100%, 48rem);
    height: auto;
    margin: var(--spacing-lg, 1rem) 0;
    border-radius: var(--smrt-radius-medium, 8px);
  }

  .content-body-renderer :global(figure[data-smrt-inline-image]) {
    display: block;
    width: min(100%, 32rem);
    max-width: 100%;
    margin: var(--spacing-lg, 1rem) 0;
  }

  .content-body-renderer :global(figure[data-smrt-inline-image] img) {
    width: 100%;
    max-width: 100%;
    margin: 0;
  }

  .content-body-renderer :global(figure[data-smrt-placement='left']),
  .content-body-renderer :global(img[data-smrt-placement='left']) {
    float: left;
    width: min(45%, 22rem);
    margin: 0.35rem var(--spacing-lg, 1rem) var(--spacing-sm, 0.5rem) 0;
  }

  .content-body-renderer :global(figure[data-smrt-placement='right']),
  .content-body-renderer :global(img[data-smrt-placement='right']) {
    float: right;
    width: min(45%, 22rem);
    margin: 0.35rem 0 var(--spacing-sm, 0.5rem) var(--spacing-lg, 1rem);
  }

  .content-body-renderer :global(figure[data-smrt-placement='center']),
  .content-body-renderer :global(figure[data-smrt-placement='block']),
  .content-body-renderer :global(img[data-smrt-placement='center']),
  .content-body-renderer :global(img[data-smrt-placement='block']) {
    float: none;
    display: block;
    margin-left: auto;
    margin-right: auto;
  }

  .content-body-renderer :global(figure[data-smrt-placement='full']),
  .content-body-renderer :global(img[data-smrt-placement='full']) {
    float: none;
    width: 100% !important;
    max-width: 100%;
    margin-left: 0;
    margin-right: 0;
    clear: both;
  }

  .content-body-renderer :global(img[data-smrt-inline-image]) {
    width: min(100%, 32rem);
    max-width: 100%;
  }

  .content-body-renderer :global(img[data-smrt-inline-image][data-smrt-placement='left']),
  .content-body-renderer :global(img[data-smrt-inline-image][data-smrt-placement='right']) {
    width: min(45%, 22rem);
  }
</style>
