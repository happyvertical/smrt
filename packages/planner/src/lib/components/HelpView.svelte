<script lang="ts">
import type { GlossaryEntry, HelpBlock, Inline } from '../recipes/help.ts';

interface HelpViewProps {
  blocks: HelpBlock[];
  glossary: GlossaryEntry[];
}

let { blocks, glossary }: HelpViewProps = $props();

/** Glossary grouped by model, so a model page can link to its own part. */
const groups = $derived(
  [...new Set(glossary.map((entry) => entry.model))].map((model) => ({
    model,
    entries: glossary.filter((entry) => entry.model === model),
  })),
);
</script>

{#snippet inline(nodes: Inline[])}
  {#each nodes as node}
    {#if node.type === 'strong'}
      <strong>{@render inline(node.children)}</strong>
    {:else if node.type === 'em'}
      <em>{@render inline(node.children)}</em>
    {:else if node.type === 'code'}
      <code>{node.text}</code>
    {:else if node.type === 'text'}
      {node.text}
    {/if}
  {/each}
{/snippet}

<article class="help">
  {#each blocks as block}
    {#if block.type === 'heading'}
      {#if block.level === 2}
        <h2>{@render inline(block.inlines)}</h2>
      {:else if block.level === 3}
        <h3>{@render inline(block.inlines)}</h3>
      {:else}
        <h4>{@render inline(block.inlines)}</h4>
      {/if}
    {:else if block.type === 'paragraph'}
      <p>{@render inline(block.inlines)}</p>
    {:else if block.ordered}
      <ol>
        {#each block.items as item}
          <li>{@render inline(item.inlines)}</li>
        {/each}
      </ol>
    {:else}
      <ul>
        {#each block.items as item}
          <li>{@render inline(item.inlines)}</li>
        {/each}
      </ul>
    {/if}
  {/each}

  {#if groups.length}
    <section aria-label="Fields">
      <h2>Fields</h2>
      {#each groups as group (group.model)}
        <section id={`fields-${group.model}`} aria-label={`${group.model} fields`}>
          {#if groups.length > 1}<h3>{group.model}</h3>{/if}
          <dl>
            {#each group.entries as entry (entry.name)}
              <dt>{entry.label}</dt>
              <dd>{entry.text}</dd>
            {/each}
          </dl>
        </section>
      {/each}
    </section>
  {/if}
</article>

<style>
  .help {
    display: grid;
    gap: var(--smrt-spacing-3);
    max-width: 48rem;
  }

  h2,
  h3,
  h4,
  p,
  ol,
  ul,
  dl {
    margin: 0;
  }

  ol,
  ul {
    display: grid;
    gap: var(--smrt-spacing-2);
    padding-left: var(--smrt-spacing-5);
  }

  section {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  dl {
    display: grid;
    gap: var(--smrt-spacing-2);
  }

  dt {
    font-weight: 600;
  }

  dd {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }
</style>
