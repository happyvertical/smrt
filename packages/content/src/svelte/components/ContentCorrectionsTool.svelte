<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { ContentCorrectionData, FactData } from '../../mock-smrt-client';
import { createClient } from '../../mock-smrt-client';
import { normalizeApiBaseUrl } from '../api';
import { M } from '../i18n.tools.js';

const { t } = useI18n();

export interface Props {
  apiBaseUrl?: string;
  contentId: string;
  defaultRelationship?: string;
  onCorrectionsChange?: (corrections: ContentCorrectionData[]) => void;
}

let {
  apiBaseUrl = '/api/v1',
  contentId,
  defaultRelationship = 'supports',
  onCorrectionsChange = undefined,
}: Props = $props();

const client = $derived(createClient(normalizeApiBaseUrl(apiBaseUrl)));
const savedContentId = $derived(
  contentId && contentId !== 'new' ? contentId : null,
);

let corrections = $state<ContentCorrectionData[]>([]);
let facts = $state<FactData[]>([]);
let busy = $state(false);
let error = $state<string | null>(null);
let notice = $state<string | null>(null);
let loadedContentId = $state<string | null>(null);

let correctionSummary = $state('');
let correctionFactId = $state('');
let correctedFactText = $state('');
let correctionPublicNote = $state('');
let publishCorrection = $state(true);

function resetCorrectionDraft() {
  correctionSummary = '';
  correctionFactId = '';
  correctedFactText = '';
  correctionPublicNote = '';
  publishCorrection = true;
}

$effect(() => {
  if (!savedContentId) {
    loadedContentId = null;
    corrections = [];
    facts = [];
    busy = false;
    error = null;
    notice = null;
    resetCorrectionDraft();
    return;
  }

  if (savedContentId !== loadedContentId) {
    loadedContentId = savedContentId;
    corrections = [];
    facts = [];
    error = null;
    notice = null;
    resetCorrectionDraft();
    void loadCorrections(savedContentId);
  }
});

$effect(() => {
  if (facts.length === 0) {
    correctionFactId = '';
    return;
  }

  const factIds = facts
    .map((fact) => fact.id)
    .filter((id): id is string => Boolean(id));

  if (!correctionFactId || !factIds.includes(correctionFactId)) {
    correctionFactId = factIds[0] ?? '';
  }
});

function formatTimestamp(value: string | null | undefined) {
  if (!value) return 'Not published';
  return new Date(value).toLocaleString();
}

function getCorrectionProvenanceCopy(correction: ContentCorrectionData) {
  const metadata = correction.metadata || {};

  if (metadata.draftVersionNumber) {
    return `Auto-created draft v${metadata.draftVersionNumber} for editorial follow-up.`;
  }

  return null;
}

async function loadCorrections(contentIdToLoad = savedContentId) {
  if (!contentIdToLoad) return;

  busy = true;
  error = null;

  try {
    const [correctionsResponse, factsResponse] = await Promise.all([
      client.contents.getCorrections(contentIdToLoad),
      client.contents.getFacts(contentIdToLoad, defaultRelationship),
    ]);
    if (savedContentId !== contentIdToLoad) return;
    corrections = correctionsResponse.data;
    facts = factsResponse.data.facts || [];
    onCorrectionsChange?.(correctionsResponse.data);
  } catch (err: any) {
    if (savedContentId !== contentIdToLoad) return;
    error = err.message || 'Failed to load corrections';
  } finally {
    if (savedContentId === contentIdToLoad) {
      busy = false;
    }
  }
}

async function issueCorrection() {
  if (!savedContentId || busy) return;

  const contentIdToCorrect = savedContentId;
  busy = true;
  error = null;
  notice = null;

  try {
    await client.contents.issueCorrection(contentIdToCorrect, {
      summary: correctionSummary,
      factId: correctionFactId || undefined,
      correctedFactText: correctedFactText || undefined,
      publicNote: correctionPublicNote || undefined,
      publish: publishCorrection,
    });

    if (savedContentId !== contentIdToCorrect) return;
    resetCorrectionDraft();

    notice = 'Correction issued.';
    await loadCorrections(contentIdToCorrect);
  } catch (err: any) {
    if (savedContentId !== contentIdToCorrect) return;
    error = err.message || 'Failed to issue correction';
  } finally {
    if (savedContentId === contentIdToCorrect) {
      busy = false;
    }
  }
}
</script>

<div class="governance-tool">
  {#if error}
    <p class="tool-error">{error}</p>
  {/if}

  {#if notice}
    <p class="tool-notice">{notice}</p>
  {/if}

  {#if !savedContentId}
    <p class="empty-copy">{t(M['content.corrections_tool.save_to_issue_corrections'])}</p>
  {:else}
    <label class="workflow-field">
      Summary
      <input
        type="text"
        bind:value={correctionSummary}
        placeholder={t(M['content.corrections_tool.what_was_wrong'])}
      />
    </label>

    <label class="workflow-field">
      {t(M['content.corrections_tool.related_fact'])}
      <select bind:value={correctionFactId}>
        <option value="">{t(M['content.corrections_tool.general_correction'])}</option>
        {#each facts as fact (fact.id)}
          <option value={fact.id ?? ''}>{fact.textRefined}</option>
        {/each}
      </select>
    </label>

    <label class="workflow-field">
      {t(M['content.corrections_tool.corrected_fact_text'])}
      <textarea
        rows="4"
        bind:value={correctedFactText}
        placeholder={t(M['content.corrections_tool.provide_corrected_wording'])}
      ></textarea>
    </label>

    <label class="workflow-field">
      {t(M['content.corrections_tool.public_note'])}
      <textarea
        rows="3"
        bind:value={correctionPublicNote}
        placeholder={t(M['content.corrections_tool.optional_public_correction_note'])}
      ></textarea>
    </label>

    <label class="checkbox-row">
      <input type="checkbox" bind:checked={publishCorrection} />
      {t(M['content.corrections_tool.publish_immediately'])}
    </label>

    <button
      type="button"
      disabled={busy || correctionSummary.trim().length === 0}
      onclick={() => void issueCorrection()}
    >
      {busy ? 'Issuing correction...' : 'Issue correction'}
    </button>

    <div class="tool-list">
      <div class="section-caption">{t(M['content.corrections_tool.published_history'])}</div>
      {#if corrections.length === 0}
        <p class="empty-copy">{t(M['content.corrections_tool.no_corrections_issued'])}</p>
      {:else}
        {#each corrections as correction (correction.id ?? `${correction.correctionType}-${correction.createdAt}`)}
          <div class="tool-card">
            <div class="tool-card-header">
              <strong>{correction.correctionType}</strong>
              <span class={`pill pill--${correction.status}`}>{correction.status}</span>
            </div>
            <p>{correction.summary}</p>
            <span>{formatTimestamp(correction.publishedAt)}</span>
            {#if getCorrectionProvenanceCopy(correction)}
              <span>{getCorrectionProvenanceCopy(correction)}</span>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .governance-tool,
  .tool-list,
  .workflow-field {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .workflow-field {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .workflow-field input,
  .workflow-field textarea,
  .workflow-field select {
    width: 100%;
    box-sizing: border-box;
    padding: 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid var(--smrt-color-outline);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font-family: inherit;
  }

  button {
    border: none;
    border-radius: 0.5rem;
    padding: 0.7rem 0.95rem;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary, white);
    cursor: pointer;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }

  .tool-card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.75rem;
    padding: 0.85rem;
  }

  .tool-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .tool-card span,
  .empty-copy,
  .section-caption {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }

  .tool-card p {
    margin: 0;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--smrt-color-on-surface);
  }

  .pill {
    border-radius: var(--smrt-radius-full, 9999px);
    padding: 0.2rem 0.55rem;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: capitalize;
  }

  .pill--published,
  .pill--neutral {
    background: color-mix(in srgb, var(--smrt-color-primary) 14%, transparent);
    color: var(--smrt-color-on-primary-container);
  }

  .pill--draft,
  .pill--retracted {
    background: color-mix(in srgb, var(--smrt-color-error) 14%, transparent);
    color: var(--smrt-color-on-error-container);
  }

  .tool-error,
  .tool-notice {
    margin: 0;
    border-radius: 0.6rem;
    padding: 0.75rem 0.9rem;
    font-size: var(--smrt-typography-body-medium-size, 0.9rem);
  }

  .tool-error {
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    color: var(--smrt-color-on-error-container);
  }

  .tool-notice {
    background: color-mix(in srgb, var(--smrt-color-primary) 10%, transparent);
    color: var(--smrt-color-on-primary-container);
  }
</style>
