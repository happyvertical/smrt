<script lang="ts">
interface Props {
  content: string;
}

const { content }: Props = $props();

// Simple markdown renderer
const rendered = $derived(renderMarkdown(content));

function renderMarkdown(markdown: string): string {
  return markdown
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/gim, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/gim, '<em>$1</em>')
    .replace(/^- (.*$)/gim, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
}
</script>

<div class="markdown-content">
  {@html rendered}
</div>

<style>
  .markdown-content {
    font-size: var(--font-size-lg);
    line-height: var(--line-height-relaxed);
    color: var(--color-text-primary);
  }

  .markdown-content :global(h1) {
    font-size: var(--font-size-4xl);
    margin: var(--spacing-2xl) 0 var(--spacing-lg) 0;
    color: var(--color-text-primary);
    font-weight: var(--font-weight-semibold);
  }

  .markdown-content :global(h2) {
    font-size: var(--font-size-3xl);
    margin: var(--spacing-xl) 0 var(--spacing-md) 0;
    color: var(--color-text-primary);
    font-weight: var(--font-weight-semibold);
  }

  .markdown-content :global(h3) {
    font-size: var(--font-size-2xl);
    margin: var(--spacing-lg) 0 var(--spacing-sm) 0;
    color: var(--color-text-primary);
    font-weight: var(--font-weight-semibold);
  }

  .markdown-content :global(p) {
    margin: var(--spacing-md) 0;
  }

  .markdown-content :global(ul) {
    margin: var(--spacing-md) 0;
    padding-left: var(--spacing-xl);
  }

  .markdown-content :global(li) {
    margin: var(--spacing-sm) 0;
  }

  .markdown-content :global(strong) {
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-primary);
  }

  .markdown-content :global(em) {
    font-style: italic;
  }
</style>
