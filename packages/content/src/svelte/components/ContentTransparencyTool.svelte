<script lang="ts">
import type {
  ContentGovernanceStateData,
  ContentTransparencyData,
} from '../../mock-smrt-client';
import { createClient } from '../../mock-smrt-client';
import { normalizeApiBaseUrl } from '../api';

export interface Props {
  apiBaseUrl?: string;
  contentId: string;
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
  } catch (err: any) {
    if (savedContentId !== contentIdToLoad) return;
    error = err.message || 'Failed to load transparency';
  } finally {
    if (savedContentId === contentIdToLoad) {
      busy = false;
    }
  }
}
</script>

<div class="governance-tool">
  {#if error}
    <p class="tool-error">{error}</p>
  {/if}

  {#if !savedContentId}
    <p class="empty-copy">Save this content to preview the public transparency breakdown.</p>
  {:else if busy && !transparencyPreview}
    <p class="empty-copy">Loading transparency...</p>
  {:else if governanceState && !governanceState.transparencyEnabled}
    <p class="empty-copy">Public transparency snapshots are not enabled for this governed content type.</p>
  {:else if !transparencyPreview}
    <p class="empty-copy">No transparency preview is available yet.</p>
  {:else}
    <p class="section-caption">
      The preview below reflects the latest saved article state. The published snapshot stays frozen until the next successful publication.
    </p>

    <div class="transparency-stats">
      <div class="transparency-stat">
        <strong>{transparencyPreview.factsUsed.length}</strong>
        <span>Facts used</span>
      </div>
      <div class="transparency-stat">
        <strong>{transparencyPreview.references.length}</strong>
        <span>References</span>
      </div>
      <div class="transparency-stat">
        <strong>{transparencyPreview.otherExtractedFacts.length}</strong>
        <span>Other extracted facts</span>
      </div>
      <div class="transparency-stat">
        <strong>{transparencyPreview.corrections.length}</strong>
        <span>Public corrections</span>
      </div>
    </div>

    <div class="transparency-card">
      <div class="tool-card-header">
        <strong>Current preview</strong>
        <span class="pill pill--neutral">{transparencyPreview.snapshotKind}</span>
      </div>
      <span>
        {#if transparencyPreview.generation.publicPrompt}
          Public prompt is set for publication.
        {:else}
          No public prompt is exposed yet.
        {/if}
      </span>
      {#if transparencyPreview.generation.publicPrompt}
        <p class="transparency-card-prompt">
          {transparencyPreview.generation.publicPrompt}
        </p>
      {/if}

      <div class="tool-list">
        <div class="tool-list-section">
          <div class="section-caption">Facts used in the article</div>
          {#if transparencyPreview.factsUsed.length === 0}
            <p class="empty-copy">No used facts will be shown publicly yet.</p>
          {:else}
            {#each transparencyPreview.factsUsed.slice(0, 3) as fact (fact.id ?? fact.textRefined ?? fact.textRaw)}
              <div class="transparency-list-item">
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

        <div class="tool-list-section">
          <div class="section-caption">Source material</div>
          {#if transparencyPreview.references.length === 0}
            <p class="empty-copy">No references will be shown publicly yet.</p>
          {:else}
            {#each transparencyPreview.references.slice(0, 3) as reference (reference.id ?? reference.url ?? reference.title)}
              <div class="transparency-list-item">
                <strong>{getReferenceLabel(reference)}</strong>
                <span>
                  {reference.usedFactIds.length} used fact(s) · {reference.extractedFacts.length} extracted fact(s)
                </span>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </div>

    <div class="transparency-card">
      <div class="tool-card-header">
        <strong>Latest published snapshot</strong>
        {#if publishedTransparency?.publicationVersion?.version !== null && publishedTransparency?.publicationVersion?.version !== undefined}
          <span class="pill pill--passed">v{publishedTransparency.publicationVersion.version}</span>
        {/if}
      </div>

      {#if publishedTransparency}
        <span>
          Published {formatTimestamp(publishedTransparency.publicationVersion?.createdAt || publishedTransparency.generatedAt)}
        </span>
        <span>
          {publishedTransparency.versionHistory.length} timeline event(s) and {publishedTransparency.corrections.length} public correction(s)
        </span>
      {:else}
        <p class="empty-copy">
          No published transparency snapshot yet. Publish this article to freeze one for the built site.
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .governance-tool,
  .tool-list,
  .tool-list-section,
  .transparency-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .transparency-stats {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  }

  .transparency-stat,
  .transparency-card,
  .transparency-list-item {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.75rem;
  }

  .transparency-stat {
    padding: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .transparency-card {
    padding: 0.9rem;
  }

  .tool-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .transparency-list-item {
    padding: 0.7rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .transparency-card span,
  .transparency-list-item span,
  .transparency-stat span,
  .empty-copy,
  .section-caption {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }

  .transparency-card-prompt,
  .empty-copy {
    margin: 0;
  }

  .transparency-card-prompt {
    color: var(--smrt-color-on-surface-variant);
    white-space: pre-wrap;
  }

  .pill {
    border-radius: var(--smrt-radius-full, 9999px);
    padding: 0.2rem 0.55rem;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: capitalize;
  }

  .pill--passed {
    background: color-mix(in srgb, var(--smrt-color-success) 14%, transparent);
    color: var(--smrt-color-on-success-container);
  }

  .pill--neutral {
    background: color-mix(in srgb, var(--smrt-color-primary) 14%, transparent);
    color: var(--smrt-color-on-primary-container);
  }

  .tool-error {
    margin: 0;
    border-radius: 0.6rem;
    padding: 0.75rem 0.9rem;
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    color: var(--smrt-color-on-error-container);
    font-size: var(--smrt-typography-body-medium-size, 0.9rem);
  }
</style>
