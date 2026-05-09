<script lang="ts">
/**
 * Markdown Component
 *
 * A simple markdown renderer with XSS protection.
 *
 * @example
 * <Markdown content="# Hello\n\nThis is **bold** text." />
 */
import { renderMarkdownToHtml } from '../../body-format';

/** Props for the Markdown component */
export interface Props {
  /** Markdown content to render */
  content: string;
  /** Optional CSS class for styling */
  class?: string;
}

let { content, class: className = '' }: Props = $props();

const rendered = $derived(renderMarkdownToHtml(content));
</script>

<div class="markdown-content {className}">
  {@html rendered}
</div>

<style>
  .markdown-content {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: var(--smrt-typography-body-large-line-height, 1.5);
    color: var(--smrt-color-on-surface);
  }

  .markdown-content :global(h1) {
    font-size: var(--smrt-typography-headline-large-size, 2rem);
    margin: var(--spacing-2xl, 2rem) 0 var(--spacing-lg, 1rem) 0;
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-headline-large-weight, 400);
    line-height: var(--smrt-typography-headline-large-line-height, 2.5rem);
  }

  .markdown-content :global(h2) {
    font-size: var(--smrt-typography-headline-medium-size, 1.75rem);
    margin: var(--spacing-xl, 1.5rem) 0 var(--spacing-md, 0.75rem) 0;
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-headline-medium-weight, 400);
    line-height: var(--smrt-typography-headline-medium-line-height, 2.25rem);
  }

  .markdown-content :global(h3) {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    margin: var(--spacing-lg, 1rem) 0 var(--spacing-sm, 0.5rem) 0;
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-headline-small-weight, 400);
    line-height: var(--smrt-typography-headline-small-line-height, 2rem);
  }

  .markdown-content :global(p) {
    margin: var(--spacing-md, 0.75rem) 0;
  }

  .markdown-content :global(p:first-child) {
    margin-top: 0;
  }

  .markdown-content :global(p:last-child) {
    margin-bottom: 0;
  }

  .markdown-content :global(ul) {
    margin: var(--spacing-md, 0.75rem) 0;
    padding-left: var(--spacing-xl, 1.5rem);
  }

  .markdown-content :global(li) {
    margin: var(--spacing-xs, 0.25rem) 0;
  }

  .markdown-content :global(strong) {
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface);
  }

  .markdown-content :global(em) {
    font-style: italic;
  }

  .markdown-content :global(code) {
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: 0.875em;
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
    padding: 0.125rem 0.375rem;
    border-radius: var(--smrt-radius-small, 4px);
  }

  .markdown-content :global(pre) {
    background: var(--smrt-color-surface-container-high);
    padding: var(--spacing-md, 0.75rem);
    border-radius: var(--smrt-radius-medium, 8px);
    overflow-x: auto;
    margin: var(--spacing-md, 0.75rem) 0;
  }

  .markdown-content :global(pre code) {
    background: transparent;
    padding: 0;
  }

  .markdown-content :global(a) {
    color: var(--smrt-color-primary);
    text-decoration: underline;
    text-underline-offset: 0.18em;
  }

  .markdown-content :global(img) {
    display: block;
    width: min(100%, 48rem);
    height: auto;
    margin: var(--spacing-lg, 1rem) 0;
    border-radius: var(--smrt-radius-medium, 8px);
  }
</style>
