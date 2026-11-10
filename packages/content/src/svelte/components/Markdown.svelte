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

<div class="smrt-markdown__root {className}" data-smrt-component="Markdown">
  {@html rendered}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-markdown__root :global(h1) {
    margin: var(--smrt-spacing-2xl, 2rem) 0 var(--smrt-spacing-lg, 1rem) 0;
  }
  .smrt-markdown__root :global(h2) {
    margin: var(--smrt-spacing-xl, 1.5rem) 0 var(--smrt-spacing-md, 0.75rem) 0;
  }
  .smrt-markdown__root :global(h3) {
    margin: var(--smrt-spacing-lg, 1rem) 0 var(--smrt-spacing-sm, 0.5rem) 0;
  }
  .smrt-markdown__root :global(p) {
    margin: var(--smrt-spacing-md, 0.75rem) 0;
  }
  .smrt-markdown__root :global(p:first-child) {
    margin-top: 0;
  }
  .smrt-markdown__root :global(p:last-child) {
    margin-bottom: 0;
  }
  .smrt-markdown__root :global(ul) {
    margin: var(--smrt-spacing-md, 0.75rem) 0;
    padding-left: var(--smrt-spacing-xl, 1.5rem);
  }
  .smrt-markdown__root :global(li) {
    margin: var(--smrt-spacing-xs, 0.25rem) 0;
  }
  .smrt-markdown__root :global(code) {
    padding: 0.125rem 0.375rem;
  }
  .smrt-markdown__root :global(pre) {
    padding: var(--smrt-spacing-md, 0.75rem);
    overflow-x: auto;
    margin: var(--smrt-spacing-md, 0.75rem) 0;
  }
  .smrt-markdown__root :global(pre code) {
    padding: 0;
  }
  .smrt-markdown__root :global(img) {
    display: block;
    width: min(100%, 48rem);
    height: auto;
    margin: var(--smrt-spacing-lg, 1rem) 0;
  }
}

@layer smrt.theme {
  .smrt-markdown__root {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: var(--smrt-typography-body-large-line-height, 1.5);
    color: var(--smrt-color-on-surface);
  }
  .smrt-markdown__root :global(h1) {
    font-size: var(--smrt-typography-headline-large-size, 2rem);
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-headline-large-weight, 400);
    line-height: var(--smrt-typography-headline-large-line-height, 2.5rem);
  }
  .smrt-markdown__root :global(h2) {
    font-size: var(--smrt-typography-headline-medium-size, 1.75rem);
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-headline-medium-weight, 400);
    line-height: var(--smrt-typography-headline-medium-line-height, 2.25rem);
  }
  .smrt-markdown__root :global(h3) {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-headline-small-weight, 400);
    line-height: var(--smrt-typography-headline-small-line-height, 2rem);
  }
  .smrt-markdown__root :global(strong) {
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface);
  }
  .smrt-markdown__root :global(em) {
    font-style: italic;
  }
  .smrt-markdown__root :global(code) {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: 0.875em;
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
    border-radius: var(--smrt-radius-small);
  }
  .smrt-markdown__root :global(pre) {
    background: var(--smrt-color-surface-container-high);
    border-radius: var(--smrt-radius-medium);
  }
  .smrt-markdown__root :global(pre code) {
    background: transparent;
  }
  .smrt-markdown__root :global(a) {
    color: var(--smrt-color-primary);
    text-decoration: underline;
    text-underline-offset: 0.18em;
  }
  .smrt-markdown__root :global(img) {
    border-radius: var(--smrt-radius-medium);
  }
}

</style>
