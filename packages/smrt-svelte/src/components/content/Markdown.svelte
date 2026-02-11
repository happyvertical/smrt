<script lang="ts">
/**
 * Markdown Component
 *
 * A simple markdown renderer with XSS protection.
 *
 * @example
 * <Markdown content="# Hello\n\nThis is **bold** text." />
 */
interface Props {
  /** Markdown content to render */
  content: string;
  /** Optional CSS class for styling */
  class?: string;
}

const { content, class: className = '' }: Props = $props();

/**
 * Escape HTML special characters to prevent XSS attacks.
 * This must be called before any markdown transformations.
 */
function escapeHtml(text: string): string {
  const htmlEntities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEntities[char]);
}

/**
 * Render markdown to HTML with XSS protection.
 *
 * Security: All HTML in the input is escaped before markdown processing.
 * The output should still be considered potentially dangerous if the input
 * contains malicious markdown, so use with caution.
 */
function renderMarkdown(markdown: string): string {
  if (!markdown || typeof markdown !== 'string') {
    return '';
  }

  // First escape HTML to prevent XSS
  let html = escapeHtml(markdown);

  // Process block-level elements first
  const lines = html.split('\n');
  const result: string[] = [];
  let inList = false;
  let inParagraph = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle empty lines
    if (!trimmed) {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      if (inParagraph) {
        result.push('</p>');
        inParagraph = false;
      }
      continue;
    }

    // Handle headers
    if (trimmed.startsWith('# ')) {
      if (inParagraph) {
        result.push('</p>');
        inParagraph = false;
      }
      result.push(`<h1>${trimmed.substring(2)}</h1>`);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      if (inParagraph) {
        result.push('</p>');
        inParagraph = false;
      }
      result.push(`<h2>${trimmed.substring(3)}</h2>`);
      continue;
    }
    if (trimmed.startsWith('### ')) {
      if (inParagraph) {
        result.push('</p>');
        inParagraph = false;
      }
      result.push(`<h3>${trimmed.substring(4)}</h3>`);
      continue;
    }

    // Handle list items
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (inParagraph) {
        result.push('</p>');
        inParagraph = false;
      }
      if (!inList) {
        result.push('<ul>');
        inList = true;
      }
      result.push(`<li>${trimmed.substring(2)}</li>`);
      continue;
    }

    // Regular paragraph text
    if (inList) {
      result.push('</ul>');
      inList = false;
    }
    if (!inParagraph) {
      result.push('<p>');
      inParagraph = true;
    }
    result.push(line);
  }

  // Close any open tags
  if (inList) {
    result.push('</ul>');
  }
  if (inParagraph) {
    result.push('</p>');
  }

  // Join and process inline elements
  html = result.join('\n');

  // Process inline formatting
  // Bold: **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic: *text* (but not inside bold)
  html = html.replace(/(?<!<strong>)\*([^*]+)\*(?!<\/strong>)/g, '<em>$1</em>');
  // Inline code: `text`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  return html;
}

const rendered = $derived(renderMarkdown(content));
</script>

<div class="markdown-content {className}">
  {@html rendered}
</div>

<style>
  .markdown-content {
    font-size: var(--md-sys-typescale-body-large-size, 1rem);
    line-height: var(--md-sys-typescale-body-large-line-height, 1.5);
    color: var(--md-sys-color-on-surface);
  }

  .markdown-content :global(h1) {
    font-size: var(--md-sys-typescale-headline-large-size, 2rem);
    margin: var(--spacing-2xl, 2rem) 0 var(--spacing-lg, 1rem) 0;
    color: var(--md-sys-color-on-surface);
    font-weight: var(--md-sys-typescale-headline-large-weight, 400);
    line-height: var(--md-sys-typescale-headline-large-line-height, 2.5rem);
  }

  .markdown-content :global(h2) {
    font-size: var(--md-sys-typescale-headline-medium-size, 1.75rem);
    margin: var(--spacing-xl, 1.5rem) 0 var(--spacing-md, 0.75rem) 0;
    color: var(--md-sys-color-on-surface);
    font-weight: var(--md-sys-typescale-headline-medium-weight, 400);
    line-height: var(--md-sys-typescale-headline-medium-line-height, 2.25rem);
  }

  .markdown-content :global(h3) {
    font-size: var(--md-sys-typescale-headline-small-size, 1.5rem);
    margin: var(--spacing-lg, 1rem) 0 var(--spacing-sm, 0.5rem) 0;
    color: var(--md-sys-color-on-surface);
    font-weight: var(--md-sys-typescale-headline-small-weight, 400);
    line-height: var(--md-sys-typescale-headline-small-line-height, 2rem);
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
    font-weight: var(--md-sys-typescale-weight-bold, 700);
    color: var(--md-sys-color-on-surface);
  }

  .markdown-content :global(em) {
    font-style: italic;
  }

  .markdown-content :global(code) {
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: 0.875em;
    background: var(--md-sys-color-surface-container-high);
    color: var(--md-sys-color-on-surface-variant);
    padding: 0.125rem 0.375rem;
    border-radius: var(--md-sys-shape-corner-small, 4px);
  }

  .markdown-content :global(pre) {
    background: var(--md-sys-color-surface-container-high);
    padding: var(--spacing-md, 0.75rem);
    border-radius: var(--md-sys-shape-corner-medium, 8px);
    overflow-x: auto;
    margin: var(--spacing-md, 0.75rem) 0;
  }

  .markdown-content :global(pre code) {
    background: transparent;
    padding: 0;
  }
</style>
