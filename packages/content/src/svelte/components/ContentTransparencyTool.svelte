<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type {
  ContentGovernanceStateData,
  ContentTransparencyData,
} from '../../mock-smrt-client';
import { createClient } from '../../mock-smrt-client';
import { normalizeApiBaseUrl } from '../api';
import { M } from '../i18n.tools.js';

const { t } = useI18n();

export interface Props {
  /** Base URL for content API requests. */
  apiBaseUrl?: string;
  /** ID of the content item to analyze for transparency. */
  contentId: string;
  /** Invoked when the governance state of the content changes. */
  onGovernanceStateChange?: (state: ContentGovernanceStateData | null) => void;
}

let {
  apiBaseUrl = '/api/v1',
  contentId,
  onGovernanceStateChange = undefined,
}: Props = $props();

const client = $derived(createClient(normalizeApiBaseUrl(apiBaseUrl)));
const savedContentId = $derived(
  contentId && contentId !== 'new' ? contentId : null,
);

let governanceState = $state<ContentGovernanceStateData | null>(null);
let transparencyPreview = $state<ContentTransparencyData | null>(null);
let publishedTransparency = $state<ContentTransparencyData | null>(null);
let busy = $state(false);
let error = $state<string | null>(null);
let loadedContentId = $state<string | null>(null);

$effect(() => {
  if (!savedContentId) {
    loadedContentId = null;
    governanceState = null;
    transparencyPreview = null;
    publishedTransparency = null;
    busy = false;
    error = null;
    onGovernanceStateChange?.(null);
    return;
  }

  if (savedContentId !== loadedContentId) {
    loadedContentId = savedContentId;
    governanceState = null;
    transparencyPreview = null;
    publishedTransparency = null;
    error = null;
    void loadTransparency(savedContentId);
  }
});

function formatTimestamp(value: string | null | undefined) {
  if (!value) return 'Not published';
  return new Date(value).toLocaleString();
}

function getReferenceLabel(reference: {
  title?: string | null;
  url?: string | null;
}) {
  return reference.title || reference.url || 'Untitled reference';
}

async function loadTransparency(contentIdToLoad = savedContentId) {
  if (!contentIdToLoad) return;

  busy = true;
  error = null;

  try {
    const [
      governanceResponse,
      transparencyPreviewResponse,
      publishedTransparencyResponse,
    ] = await Promise.all([
      client.contents.getGovernanceState(contentIdToLoad),
      client.contents.getTransparencyPreview(contentIdToLoad),
      client.contents.getPublishedTransparency(contentIdToLoad),
    ]);
    if (savedContentId !== contentIdToLoad) return;
    governanceState = governanceResponse.data;
    transparencyPreview = transparencyPreviewResponse.data;
    publishedTransparency = publishedTransparencyResponse.data;
    onGovernanceStateChange?.(governanceResponse.data);
  } catch (err) {
    if (savedContentId !== contentIdToLoad) return;
    error =
      (err instanceof Error ? err.message : '') ||
      'Failed to load transparency';
  } finally {
    if (savedContentId === contentIdToLoad) {
      busy = false;
    }
  }
}
</script>

<div class="smrt-content-transparency-tool__root" data-smrt-component="ContentTransparencyTool">
  {#if error}
    <p class="smrt-content-transparency-tool__error" data-smrt-part="error">{error}</p>
  {/if}

  {#if !savedContentId}
    <p class="smrt-content-transparency-tool__empty" data-smrt-part="empty">{t(M['content.transparency_tool.save_to_preview_transparency'])}</p>
  {:else if busy && !transparencyPreview}
    <p class="smrt-content-transparency-tool__empty" data-smrt-part="empty">{t(M['content.transparency_tool.loading_transparency'])}</p>
  {:else if governanceState && !governanceState.transparencyEnabled}
    <p class="smrt-content-transparency-tool__empty" data-smrt-part="empty">{t(M['content.transparency_tool.transparency_snapshots_not_enabled'])}</p>
  {:else if !transparencyPreview}
    <p class="smrt-content-transparency-tool__empty" data-smrt-part="empty">{t(M['content.transparency_tool.no_transparency_preview'])}</p>
  {:else}
    <p class="smrt-content-transparency-tool__caption" data-smrt-part="caption">
      {t(M['content.transparency_tool.transparency_preview_explainer'])}
    </p>

    <div class="smrt-content-transparency-tool__stats" data-smrt-part="stats">
      <div class="smrt-content-transparency-tool__stat" data-smrt-part="stat">
        <strong>{transparencyPreview.factsUsed.length}</strong>
        <span>{t(M['content.transparency_tool.facts_used'])}</span>
      </div>
      <div class="smrt-content-transparency-tool__stat" data-smrt-part="stat">
        <strong>{transparencyPreview.references.length}</strong>
        <span>References</span>
      </div>
      <div class="smrt-content-transparency-tool__stat" data-smrt-part="stat">
        <strong>{transparencyPreview.otherExtractedFacts.length}</strong>
        <span>{t(M['content.transparency_tool.other_extracted_facts'])}</span>
      </div>
      <div class="smrt-content-transparency-tool__stat" data-smrt-part="stat">
        <strong>{transparencyPreview.corrections.length}</strong>
        <span>{t(M['content.transparency_tool.public_corrections'])}</span>
      </div>
    </div>

    <div class="smrt-content-transparency-tool__card" data-smrt-part="card">
      <div class="smrt-content-transparency-tool__header" data-smrt-part="header">
        <strong>{t(M['content.transparency_tool.current_preview'])}</strong>
        <span class="smrt-content-transparency-tool__pill smrt-content-transparency-tool__pill--neutral" data-smrt-part="badge">{transparencyPreview.snapshotKind}</span>
      </div>
      <span>
        {#if transparencyPreview.generation.publicPrompt}
          {t(M['content.transparency_tool.public_prompt_set'])}
        {:else}
          {t(M['content.transparency_tool.no_public_prompt_exposed'])}
        {/if}
      </span>
      {#if transparencyPreview.generation.publicPrompt}
        <p class="smrt-content-transparency-tool__prompt" data-smrt-part="prompt">
          {transparencyPreview.generation.publicPrompt}
        </p>
      {/if}

      <div class="smrt-content-transparency-tool__list" data-smrt-part="list">
        <div class="smrt-content-transparency-tool__list-section" data-smrt-part="section">
          <div class="smrt-content-transparency-tool__caption" data-smrt-part="caption">{t(M['content.transparency_tool.facts_used_in_article'])}</div>
          {#if transparencyPreview.factsUsed.length === 0}
            <p class="smrt-content-transparency-tool__empty" data-smrt-part="empty">{t(M['content.transparency_tool.no_used_facts_public'])}</p>
          {:else}
            {#each transparencyPreview.factsUsed.slice(0, 3) as fact (fact.id ?? fact.textRefined ?? fact.textRaw)}
              <div class="smrt-content-transparency-tool__item" data-smrt-part="item">
                <strong>{fact.textRefined || fact.textRaw || fact.id}</strong>
                <span>
                  {fact.relationship || 'linked'}
                  {#if fact.sources && fact.sources.length > 0}
                    · {fact.sources.length} source(s)
                  {/if}
                </span>
              </div>
            {/each}
          {/if}
        </div>

        <div class="smrt-content-transparency-tool__list-section" data-smrt-part="section">
          <div class="smrt-content-transparency-tool__caption" data-smrt-part="caption">{t(M['content.transparency_tool.source_material'])}</div>
          {#if transparencyPreview.references.length === 0}
            <p class="smrt-content-transparency-tool__empty" data-smrt-part="empty">{t(M['content.transparency_tool.no_references_public'])}</p>
          {:else}
            {#each transparencyPreview.references.slice(0, 3) as reference (reference.id ?? reference.url ?? reference.title)}
              <div class="smrt-content-transparency-tool__item" data-smrt-part="item">
                <strong>{getReferenceLabel(reference)}</strong>
                <span>
                  {t(M['content.transparency_tool.reference_fact_counts'], { used: reference.usedFactIds.length, extracted: reference.extractedFacts.length })}
                </span>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </div>

    <div class="smrt-content-transparency-tool__card" data-smrt-part="card">
      <div class="smrt-content-transparency-tool__header" data-smrt-part="header">
        <strong>{t(M['content.transparency_tool.latest_published_snapshot'])}</strong>
        {#if publishedTransparency?.publicationVersion?.version !== null && publishedTransparency?.publicationVersion?.version !== undefined}
          <span class="smrt-content-transparency-tool__pill smrt-content-transparency-tool__pill--passed" data-smrt-part="badge">v{publishedTransparency.publicationVersion.version}</span>
        {/if}
      </div>

      {#if publishedTransparency}
        <span>
          Published {formatTimestamp(publishedTransparency.publicationVersion?.createdAt || publishedTransparency.generatedAt)}
        </span>
        <span>
          {t(M['content.transparency_tool.timeline_and_corrections'], { events: publishedTransparency.versionHistory.length, corrections: publishedTransparency.corrections.length })}
        </span>
      {:else}
        <p class="smrt-content-transparency-tool__empty" data-smrt-part="empty">
          {t(M['content.transparency_tool.no_published_snapshot'])}
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  /* The tool lays itself out by its own width, not the viewport, so it
  fits a full page, a side panel, the assistant dock or a phone. */
  .smrt-content-transparency-tool__root {
    container-type: inline-size;
    container-name: governance-tool;
  }
  .smrt-content-transparency-tool__root,
  .smrt-content-transparency-tool__list,
  .smrt-content-transparency-tool__list-section,
  .smrt-content-transparency-tool__card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-content-transparency-tool__stats {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(min(120px, 100%), 1fr));
  }
  .smrt-content-transparency-tool__stat {
    padding: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .smrt-content-transparency-tool__card {
    padding: 0.9rem;
  }
  .smrt-content-transparency-tool__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .smrt-content-transparency-tool__item {
    padding: 0.7rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .smrt-content-transparency-tool__prompt,
  .smrt-content-transparency-tool__empty {
    margin: 0;
  }
  .smrt-content-transparency-tool__prompt {
    white-space: pre-wrap;
  }
  .smrt-content-transparency-tool__pill {
    padding: 0.2rem 0.55rem;
  }
  .smrt-content-transparency-tool__error {
    margin: 0;
    padding: 0.75rem 0.9rem;
  }
  @container governance-tool (max-width: 30rem) {
    .smrt-content-transparency-tool__header {
      flex-wrap: wrap;
    }
  }
}

@layer smrt.theme {
  .smrt-content-transparency-tool__stat,
  .smrt-content-transparency-tool__card,
  .smrt-content-transparency-tool__item {
    background: var(--smrt-card-background, var(--smrt-color-surface));
    border: var(--smrt-card-border, var(--smrt-hairline));
    box-shadow: var(--smrt-card-shadow, none);
    border-radius: 0.75rem;
  }
  .smrt-content-transparency-tool__item {
    background: color-mix(in srgb, var(--smrt-color-on-surface) 6%, transparent);
  }
  .smrt-content-transparency-tool__card span,
  .smrt-content-transparency-tool__item span,
  .smrt-content-transparency-tool__stat span,
  .smrt-content-transparency-tool__empty,
  .smrt-content-transparency-tool__caption {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
  .smrt-content-transparency-tool__prompt {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-transparency-tool__pill {
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: capitalize;
  }
  .smrt-content-transparency-tool__pill--passed {
    background: color-mix(in srgb, var(--smrt-color-success) 14%, transparent);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-content-transparency-tool__pill--neutral {
    background: color-mix(in srgb, var(--smrt-color-primary) 14%, transparent);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-content-transparency-tool__error {
    border-radius: 0.6rem;
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    color: var(--smrt-color-on-error-container);
    font-size: var(--smrt-typography-body-medium-size, 0.9rem);
  }
}

</style>
