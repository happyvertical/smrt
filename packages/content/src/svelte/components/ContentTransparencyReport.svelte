<script lang="ts">
import type { ContentTransparencyData } from '../../mock-smrt-client';

export interface Props {
  transparency?: ContentTransparencyData | null;
  title?: string;
  emptyCopy?: string;
}

let {
  transparency = null,
  title = 'Transparency report',
  emptyCopy = 'No transparency snapshot is available.',
}: Props = $props();

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return 'Unknown';
  }

  return new Date(value).toLocaleString();
}

function getReferenceLabel(reference: {
  title?: string | null;
  url?: string | null;
}) {
  return reference.title || reference.url || 'Untitled reference';
}

function getFactLabel(fact: {
  textRefined?: string | null;
  textRaw?: string | null;
  id?: string | null;
}) {
  return fact.textRefined || fact.textRaw || fact.id || 'Untitled fact';
}
</script>

<section class="transparency-report">
  <div class="transparency-report__header">
    <div>
      <h3>{title}</h3>
      {#if transparency}
        <p>
          {transparency.snapshotKind} snapshot
          {#if transparency.publicationVersion?.version !== null && transparency.publicationVersion?.version !== undefined}
            · v{transparency.publicationVersion.version}
          {/if}
          · updated {formatTimestamp(transparency.generatedAt)}
        </p>
      {/if}
    </div>
    {#if transparency}
      <div class="transparency-report__badges">
        <span class="badge">{transparency.factsUsed.length} facts used</span>
        <span class="badge">{transparency.references.length} references</span>
        <span class="badge">{transparency.corrections.length} corrections</span>
      </div>
    {/if}
  </div>

  {#if !transparency}
    <p class="empty-copy">{emptyCopy}</p>
  {:else}
    <div class="transparency-grid">
      <article class="panel">
        <h4>Generation</h4>
        <p>
          {#if transparency.generation.aiAssisted}
            AI-assisted
          {:else}
            Authored without public AI disclosure
          {/if}
          {#if transparency.generation.model}
            · {transparency.generation.model}
          {/if}
        </p>
        {#if transparency.generation.publicPrompt}
          <pre class="prompt">{transparency.generation.publicPrompt}</pre>
        {:else}
          <p class="empty-copy">No public prompt was attached to this publication.</p>
        {/if}
      </article>

      <article class="panel">
        <h4>Facts Used</h4>
        {#if transparency.factsUsed.length === 0}
          <p class="empty-copy">No explicit facts were marked as used in the article.</p>
        {:else}
          <div class="item-list">
            {#each transparency.factsUsed as fact (fact.id ?? fact.textRefined ?? fact.textRaw)}
              <div class="item-card">
                <strong>{getFactLabel(fact)}</strong>
                <span>
                  {fact.relationship || 'linked'}
                  {#if fact.sources && fact.sources.length > 0}
                    · {fact.sources.length} source(s)
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </article>
    </div>

    <article class="panel">
      <h4>Source Material</h4>
      {#if transparency.references.length === 0}
        <p class="empty-copy">No public references are attached to this snapshot.</p>
      {:else}
        <div class="item-list">
          {#each transparency.references as reference (reference.id ?? reference.url ?? reference.title)}
            <div class="item-card">
              <div class="item-card__header">
                <strong>{getReferenceLabel(reference)}</strong>
                <span>{reference.usedFactIds.length} used · {reference.extractedFacts.length} extracted</span>
              </div>
              {#if reference.url}
                <a href={reference.url} target="_blank" rel="noreferrer">{reference.url}</a>
              {/if}
              {#if reference.extractedFacts.length > 0}
                <div class="pill-list">
                  {#each reference.extractedFacts as fact (fact.id ?? fact.textRefined ?? fact.textRaw)}
                    <span class:used={fact.usedInArticle}>{getFactLabel(fact)}</span>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </article>

    {#if transparency.otherExtractedFacts.length > 0}
      <article class="panel">
        <h4>Other Extracted Facts</h4>
        <div class="pill-list">
          {#each transparency.otherExtractedFacts as fact (fact.id ?? fact.textRefined ?? fact.textRaw)}
            <span>{getFactLabel(fact)}</span>
          {/each}
        </div>
      </article>
    {/if}

    <div class="transparency-grid">
      <article class="panel">
        <h4>Reviews</h4>
        {#if transparency.reviews.length === 0}
          <p class="empty-copy">No reviews were captured in this snapshot.</p>
        {:else}
          <div class="item-list">
            {#each transparency.reviews as review (`${review.id ?? review.policyKey}-${review.createdAt ?? ''}`)}
              <div class="item-card">
                <div class="item-card__header">
                  <strong>{review.policyKey || review.kind || 'review'}</strong>
                  <span>{review.status || 'pending'}</span>
                </div>
                <p>{review.summary || 'No summary provided.'}</p>
              </div>
            {/each}
          </div>
        {/if}
      </article>

      <article class="panel">
        <h4>Corrections</h4>
        {#if transparency.corrections.length === 0}
          <p class="empty-copy">No public corrections have been issued.</p>
        {:else}
          <div class="item-list">
            {#each transparency.corrections as correction (`${correction.id ?? correction.summary}-${correction.publishedAt ?? ''}`)}
              <div class="item-card">
                <div class="item-card__header">
                  <strong>{correction.summary || 'Correction'}</strong>
                  <span>{formatTimestamp(correction.publishedAt)}</span>
                </div>
                {#if correction.publicNote}
                  <p>{correction.publicNote}</p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </article>
    </div>

    <article class="panel">
      <h4>Version History</h4>
      {#if transparency.versionHistory.length === 0}
        <p class="empty-copy">No version history is attached to this snapshot.</p>
      {:else}
        <div class="item-list">
          {#each transparency.versionHistory as version (`${version.id ?? version.version}-${version.createdAt ?? ''}`)}
            <div class="item-card">
              <div class="item-card__header">
                <strong>v{version.version ?? '?'}</strong>
                <span>{version.kind || 'manual'} · {formatTimestamp(version.createdAt)}</span>
              </div>
              <p>{version.summary || 'No summary provided.'}</p>
            </div>
          {/each}
        </div>
      {/if}
    </article>
  {/if}
</section>

<style>
  .transparency-report {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .transparency-report__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .transparency-report__header h3,
  .panel h4 {
    margin: 0;
  }

  .transparency-report__header p,
  .panel p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .transparency-report__badges,
  .pill-list {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .badge,
  .pill-list span {
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
    padding: 0.25rem 0.65rem;
    font-size: 0.8rem;
  }

  .pill-list span.used {
    background: color-mix(
      in srgb,
      var(--smrt-color-primary) 16%,
      var(--smrt-color-surface-container-high)
    );
  }

  .transparency-grid {
    display: grid;
    gap: 1rem;
  }

  @media (min-width: 900px) {
    .transparency-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .panel {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 1rem;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .item-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .item-card {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.85rem;
    background: var(--smrt-color-surface-container-low);
    padding: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .item-card__header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .prompt {
    margin: 0;
    white-space: pre-wrap;
    font-family: inherit;
    background: var(--smrt-color-surface-container-high);
    border-radius: 0.85rem;
    padding: 0.85rem;
    color: var(--smrt-color-on-surface);
  }

  .empty-copy {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
