<script lang="ts">
/**
 * Note widget (#3727): sanitized Markdown from the `body` option. It renders
 * a parsed node tree as Svelte elements, never `{@html}`, so stored text
 * cannot inject markup or an unsafe link.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.overview.js';
import { type InlineNode, parseMarkdown } from '../markdown.js';
import type { WidgetComponentProps } from '../types.js';

let { options }: WidgetComponentProps = $props();

const { t } = useI18n();
const blocks = $derived(
  parseMarkdown(typeof options.body === 'string' ? options.body : ''),
);
</script>

{#snippet inline(nodes: InlineNode[])}
  {#each nodes as node, index (index)}
    {#if node.type === 'text'}{node.text}{:else if node.type === 'code'}<code>{node.text}</code>{:else if node.type === 'strong'}<strong>{@render inline(node.children)}</strong>{:else if node.type === 'em'}<em>{@render inline(node.children)}</em>{:else if node.type === 'link'}<a href={node.href} rel="noopener noreferrer">{@render inline(node.children)}</a>{/if}
  {/each}
{/snippet}

{#if blocks.length === 0}
  <p class="smrt-note__empty">{t(M['ui.overview.no_data'])}</p>
{:else}
  <div class="smrt-note">
    {#each blocks as block, index (index)}
      {#if block.type === 'heading'}
        <p class="smrt-note__heading" data-level={block.level}><strong>{@render inline(block.children)}</strong></p>
      {:else if block.type === 'paragraph'}
        <p>{@render inline(block.children)}</p>
      {:else if block.type === 'quote'}
        <blockquote>{@render inline(block.children)}</blockquote>
      {:else if block.type === 'list'}
        {#if block.ordered}
          <ol>{#each block.items as item, i (i)}<li>{@render inline(item)}</li>{/each}</ol>
        {:else}
          <ul>{#each block.items as item, i (i)}<li>{@render inline(item)}</li>{/each}</ul>
        {/if}
      {:else if block.type === 'code'}
        <pre><code>{block.text}</code></pre>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .smrt-note { display: grid; gap: var(--smrt-spacing-2); color: var(--smrt-color-on-surface); font-size: var(--smrt-typography-body-medium-size, 0.875rem); overflow-wrap: anywhere; }
  .smrt-note p, .smrt-note ul, .smrt-note ol, .smrt-note blockquote, .smrt-note pre { margin: 0; }
  .smrt-note ul, .smrt-note ol { padding-inline-start: var(--smrt-spacing-5, 1.25rem); }
  .smrt-note blockquote { padding-inline-start: var(--smrt-spacing-3); border-inline-start: 3px solid var(--smrt-color-outline-variant); color: var(--smrt-color-on-surface-variant); }
  .smrt-note pre { overflow-x: auto; padding: var(--smrt-spacing-2); border-radius: var(--smrt-radius-small, 0.25rem); background: var(--smrt-color-surface-container); }
  .smrt-note code { font-family: var(--smrt-font-family-mono, ui-monospace, monospace); }
  .smrt-note a { color: var(--smrt-color-primary); }
  .smrt-note__heading[data-level='1'] { font-size: var(--smrt-typography-title-large-size, 1.25rem); }
  .smrt-note__heading[data-level='2'] { font-size: var(--smrt-typography-title-medium-size, 1.125rem); }
  .smrt-note__empty { margin: 0; color: var(--smrt-color-on-surface-variant); }
</style>
