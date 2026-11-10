<script lang="ts">
interface MarkdownBlock {
  type: 'heading' | 'paragraph' | 'code' | 'list';
  text?: string;
  depth?: number;
  language?: string;
  ordered?: boolean;
  items?: string[];
}

interface Props {
  content?: string;
}

let { content = '' }: Props = $props();

const blocks = $derived(parseMarkdown(content));

function parseMarkdown(value: string): MarkdownBlock[] {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  const parsed: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] || '';
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim() || undefined;
      const code: string[] = [];
      index += 1;

      while (
        index < lines.length &&
        !(lines[index] || '').trim().startsWith('```')
      ) {
        code.push(lines[index] || '');
        index += 1;
      }

      parsed.push({
        type: 'code',
        language,
        text: code.join('\n'),
      });
      index += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      parsed.push({
        type: 'heading',
        depth: heading[1].length,
        text: heading[2],
      });
      index += 1;
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (unordered || ordered) {
      const items: string[] = [];
      const isOrdered = Boolean(ordered);

      while (index < lines.length) {
        const itemMatch = isOrdered
          ? /^\d+\.\s+(.+)$/.exec((lines[index] || '').trim())
          : /^[-*]\s+(.+)$/.exec((lines[index] || '').trim());
        if (!itemMatch) {
          break;
        }
        items.push(itemMatch[1]);
        index += 1;
      }

      parsed.push({
        type: 'list',
        ordered: isOrdered,
        items,
      });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] || '';
      const candidateTrimmed = candidate.trim();
      if (
        !candidateTrimmed ||
        candidateTrimmed.startsWith('```') ||
        /^#{1,4}\s+/.test(candidateTrimmed) ||
        /^[-*]\s+/.test(candidateTrimmed) ||
        /^\d+\.\s+/.test(candidateTrimmed)
      ) {
        break;
      }

      paragraph.push(candidateTrimmed);
      index += 1;
    }

    parsed.push({
      type: 'paragraph',
      text: paragraph.join(' '),
    });
  }

  return parsed;
}

function headingTag(depth = 2) {
  return `h${Math.min(Math.max(depth + 1, 2), 5)}`;
}
</script>

<div class="smrt-markdown-document__root">
  {#each blocks as block}
    {#if block.type === 'heading'}
      <svelte:element this={headingTag(block.depth)}>{block.text}</svelte:element>
    {:else if block.type === 'paragraph'}
      <p>{block.text}</p>
    {:else if block.type === 'code'}
      {#if block.language}
        <p class="smrt-markdown-document__language" data-smrt-part="language">{block.language}</p>
      {/if}
      <pre><code>{block.text}</code></pre>
    {:else if block.type === 'list' && block.ordered}
      <ol>
        {#each block.items || [] as item}
          <li>{item}</li>
        {/each}
      </ol>
    {:else if block.type === 'list'}
      <ul>
        {#each block.items || [] as item}
          <li>{item}</li>
        {/each}
      </ul>
    {/if}
  {/each}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-markdown-document__root {
    display: grid;
    gap: 0.85rem;
  }
  .smrt-markdown-document__root :global(h2),
  .smrt-markdown-document__root :global(h3),
  .smrt-markdown-document__root :global(h4),
  .smrt-markdown-document__root :global(h5),
  .smrt-markdown-document__root p,
  .smrt-markdown-document__root ul,
  .smrt-markdown-document__root ol {
    margin: 0;
  }
  .smrt-markdown-document__root ul,
  .smrt-markdown-document__root ol {
    padding-left: 1.2rem;
  }
  .smrt-markdown-document__root pre {
    margin: 0;
    overflow: auto;
    padding: 0.85rem;
  }
}

@layer smrt.theme {
  .smrt-markdown-document__root {
    line-height: 1.62;
  }
  .smrt-markdown-document__root :global(h2),
  .smrt-markdown-document__root :global(h3),
  .smrt-markdown-document__root :global(h4),
  .smrt-markdown-document__root :global(h5) {
    color: var(--smrt-color-on-surface);
    line-height: 1.25;
  }
  .smrt-markdown-document__root p,
  .smrt-markdown-document__root li {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-markdown-document__root pre {
    border: var(--smrt-hairline);
    border-radius: 6px;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
  }
  .smrt-markdown-document__language {
    color: var(--smrt-color-primary);
    font-size: 0.78rem;
    text-transform: uppercase;
  }
}

</style>
