<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { ContentTransparencyData } from '../../mock-smrt-client';
import { M } from '../i18n.tools.js';

const { t } = useI18n();

export interface Props {
  /** Transparency report data including facts and references. */
  transparency?: ContentTransparencyData | null;
  /** Title displayed at the top of the report. */
  title?: string;
  /** Message displayed when no transparency data is available. */
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

<section class="smrt-content-transparency-report__root" data-smrt-component="ContentTransparencyReport">
  <div class="smrt-content-transparency-report__header" data-smrt-part="header">
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
      <div class="smrt-content-transparency-report__badges" data-smrt-part="meta">
        <span class="smrt-content-transparency-report__badge" data-smrt-part="badge">{transparency.factsUsed.length} {t(M['content.transparency_report.facts_used'])}</span>
        <span class="smrt-content-transparency-report__badge" data-smrt-part="badge">{transparency.references.length} {t(M['content.transparency_report.references'])}</span>
        <span class="smrt-content-transparency-report__badge" data-smrt-part="badge">{transparency.corrections.length} {t(M['content.transparency_report.corrections'])}</span>
      </div>
    {/if}
  </div>

  {#if !transparency}
    <p class="smrt-content-transparency-report__empty" data-smrt-part="empty">{emptyCopy}</p>
  {:else}
    <div class="smrt-content-transparency-report__grid" data-smrt-part="grid">
      <article class="smrt-content-transparency-report__panel" data-smrt-part="panel">
        <h4>Generation</h4>
        <p>
          {#if transparency.generation.aiAssisted}
            {t(M['content.transparency_report.ai_assisted'])}
          {:else}
            {t(M['content.transparency_report.authored_without_disclosure'])}
          {/if}
          {#if transparency.generation.model}
            · {transparency.generation.model}
          {/if}
        </p>
        {#if transparency.generation.publicPrompt}
          <pre class="smrt-content-transparency-report__prompt" data-smrt-part="field">{transparency.generation.publicPrompt}</pre>
        {:else}
          <p class="smrt-content-transparency-report__empty" data-smrt-part="empty">{t(M['content.transparency_report.no_public_prompt_attached'])}</p>
        {/if}
      </article>

      <article class="smrt-content-transparency-report__panel" data-smrt-part="panel">
        <h4>{t(M['content.transparency_report.facts_used_heading'])}</h4>
        {#if transparency.factsUsed.length === 0}
          <p class="smrt-content-transparency-report__empty" data-smrt-part="empty">{t(M['content.transparency_report.no_explicit_facts'])}</p>
        {:else}
          <div class="smrt-content-transparency-report__item-list" data-smrt-part="list">
            {#each transparency.factsUsed as fact (fact.id ?? fact.textRefined ?? fact.textRaw)}
              <div class="smrt-content-transparency-report__item-card" data-smrt-part="item">
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

    <article class="smrt-content-transparency-report__panel" data-smrt-part="panel">
      <h4>{t(M['content.transparency_report.source_material'])}</h4>
      {#if transparency.references.length === 0}
        <p class="smrt-content-transparency-report__empty" data-smrt-part="empty">{t(M['content.transparency_report.no_public_references'])}</p>
      {:else}
        <div class="smrt-content-transparency-report__item-list" data-smrt-part="list">
          {#each transparency.references as reference (reference.id ?? reference.url ?? reference.title)}
            <div class="smrt-content-transparency-report__item-card" data-smrt-part="item">
              <div class="smrt-content-transparency-report__item-card-header" data-smrt-part="header">
                <strong>{getReferenceLabel(reference)}</strong>
                <span>{reference.usedFactIds.length} used · {reference.extractedFacts.length} extracted</span>
              </div>
              {#if reference.url}
                <a href={reference.url} target="_blank" rel="noreferrer">{reference.url}</a>
              {/if}
              {#if reference.extractedFacts.length > 0}
                <div class="smrt-content-transparency-report__pill-list" data-smrt-part="meta">
                  {#each reference.extractedFacts as fact (fact.id ?? fact.textRefined ?? fact.textRaw)}
                    <span class:smrt-content-transparency-report__used={fact.usedInArticle} data-smrt-part="badge">{getFactLabel(fact)}</span>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </article>

    {#if transparency.otherExtractedFacts.length > 0}
      <article class="smrt-content-transparency-report__panel" data-smrt-part="panel">
        <h4>{t(M['content.transparency_report.other_extracted_facts'])}</h4>
        <div class="smrt-content-transparency-report__pill-list" data-smrt-part="meta">
          {#each transparency.otherExtractedFacts as fact (fact.id ?? fact.textRefined ?? fact.textRaw)}
            <span>{getFactLabel(fact)}</span>
          {/each}
        </div>
      </article>
    {/if}

    <div class="smrt-content-transparency-report__grid" data-smrt-part="grid">
      <article class="smrt-content-transparency-report__panel" data-smrt-part="panel">
        <h4>Reviews</h4>
        {#if transparency.reviews.length === 0}
          <p class="smrt-content-transparency-report__empty" data-smrt-part="empty">{t(M['content.transparency_report.no_reviews_captured'])}</p>
        {:else}
          <div class="smrt-content-transparency-report__item-list" data-smrt-part="list">
            {#each transparency.reviews as review (`${review.id ?? review.policyKey}-${review.createdAt ?? ''}`)}
              <div class="smrt-content-transparency-report__item-card" data-smrt-part="item">
                <div class="smrt-content-transparency-report__item-card-header" data-smrt-part="header">
                  <strong>{review.policyKey || review.kind || 'review'}</strong>
                  <span>{review.status || 'pending'}</span>
                </div>
                <p>{review.summary || 'No summary provided.'}</p>
              </div>
            {/each}
          </div>
        {/if}
      </article>

      <article class="smrt-content-transparency-report__panel" data-smrt-part="panel">
        <h4>Corrections</h4>
        {#if transparency.corrections.length === 0}
          <p class="smrt-content-transparency-report__empty" data-smrt-part="empty">{t(M['content.transparency_report.no_public_corrections'])}</p>
        {:else}
          <div class="smrt-content-transparency-report__item-list" data-smrt-part="list">
            {#each transparency.corrections as correction (`${correction.id ?? correction.summary}-${correction.publishedAt ?? ''}`)}
              <div class="smrt-content-transparency-report__item-card" data-smrt-part="item">
                <div class="smrt-content-transparency-report__item-card-header" data-smrt-part="header">
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

    <article class="smrt-content-transparency-report__panel" data-smrt-part="panel">
      <h4>{t(M['content.transparency_report.version_history'])}</h4>
      {#if transparency.versionHistory.length === 0}
        <p class="smrt-content-transparency-report__empty" data-smrt-part="empty">{t(M['content.transparency_report.no_version_history'])}</p>
      {:else}
        <div class="smrt-content-transparency-report__item-list" data-smrt-part="list">
          {#each transparency.versionHistory as version (`${version.id ?? version.version}-${version.createdAt ?? ''}`)}
            <div class="smrt-content-transparency-report__item-card" data-smrt-part="item">
              <div class="smrt-content-transparency-report__item-card-header" data-smrt-part="header">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-content-transparency-report__root {
    container-type: inline-size;
    container-name: transparency-report;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .smrt-content-transparency-report__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .smrt-content-transparency-report__header h3,
  .smrt-content-transparency-report__panel h4 {
    margin: 0;
  }
  .smrt-content-transparency-report__header p,
  .smrt-content-transparency-report__panel p {
    margin: 0;
  }
  .smrt-content-transparency-report__badges,
  .smrt-content-transparency-report__pill-list {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .smrt-content-transparency-report__badge,
  .smrt-content-transparency-report__pill-list span {
    padding: 0.25rem 0.65rem;
  }
  .smrt-content-transparency-report__grid {
    display: grid;
    gap: 1rem;
  }
  @container transparency-report (min-width: 56rem) {
    .smrt-content-transparency-report__grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .smrt-content-transparency-report__panel {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-content-transparency-report__item-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-content-transparency-report__item-card {
    padding: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .smrt-content-transparency-report__item-card-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .smrt-content-transparency-report__prompt {
    margin: 0;
    white-space: pre-wrap;
    padding: 0.85rem;
  }
}

@layer smrt.theme {
  .smrt-content-transparency-report__header p,
  .smrt-content-transparency-report__panel p {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-transparency-report__badge,
  .smrt-content-transparency-report__pill-list span {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
  }
  .smrt-content-transparency-report__pill-list span.smrt-content-transparency-report__used {
    background: color-mix(
      in srgb,
      var(--smrt-color-primary) 16%,
      var(--smrt-color-surface-container-high)
    );
  }
  .smrt-content-transparency-report__panel {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 1rem;
  }
  .smrt-content-transparency-report__item-card {
    border: var(--smrt-hairline);
    border-radius: 0.85rem;
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-content-transparency-report__prompt {
    font-family: inherit;
    background: var(--smrt-color-surface-container-high);
    border-radius: 0.85rem;
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-transparency-report__empty {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
