<script lang="ts">
import { Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ContentCorrectionData, FactData } from '../../mock-smrt-client';
import { createClient } from '../../mock-smrt-client';
import { normalizeApiBaseUrl } from '../api';
import { M } from '../i18n.tools.js';

const { t } = useI18n();

export interface Props {
  /** Base URL for API requests to fetch and create corrections. */
  apiBaseUrl?: string;
  /** Identifier of the content being corrected. */
  contentId: string;
  /** Relationship type used to filter which related facts are loaded. */
  defaultRelationship?: string;
  /** Fired when corrections are loaded or a new correction is created. */
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
  } catch (err) {
    if (savedContentId !== contentIdToLoad) return;
    error =
      (err instanceof Error ? err.message : '') || 'Failed to load corrections';
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
  } catch (err) {
    if (savedContentId !== contentIdToCorrect) return;
    error =
      (err instanceof Error ? err.message : '') || 'Failed to issue correction';
  } finally {
    if (savedContentId === contentIdToCorrect) {
      busy = false;
    }
  }
}
</script>

<div class="smrt-content-corrections-tool__root" data-smrt-component="ContentCorrectionsTool">
  {#if error}
    <p class="smrt-content-corrections-tool__error" data-smrt-part="error" role="alert" aria-live="assertive">{error}</p>
  {/if}

  {#if notice}
    <p class="smrt-content-corrections-tool__notice" data-smrt-part="notice" role="status" aria-live="polite">{notice}</p>
  {/if}

  {#if !savedContentId}
    <p class="smrt-content-corrections-tool__empty" data-smrt-part="empty">{t(M['content.corrections_tool.save_to_issue_corrections'])}</p>
  {:else}
    <label class="smrt-content-corrections-tool__field" data-smrt-part="field">
      Summary
      <Input
        type="text"
        bind:value={correctionSummary}
        placeholder={t(M['content.corrections_tool.what_was_wrong'])}
      />
    </label>

    <label class="smrt-content-corrections-tool__field" data-smrt-part="field">
      {t(M['content.corrections_tool.related_fact'])}
      <Select bind:value={correctionFactId}>
        <option value="">{t(M['content.corrections_tool.general_correction'])}</option>
        {#each facts as fact (fact.id)}
          <option value={fact.id ?? ''}>{fact.textRefined}</option>
        {/each}
      </Select>
    </label>

    <label class="smrt-content-corrections-tool__field" data-smrt-part="field">
      {t(M['content.corrections_tool.corrected_fact_text'])}
      <Textarea
        rows={4}
        bind:value={correctedFactText}
        placeholder={t(M['content.corrections_tool.provide_corrected_wording'])}
      ></Textarea>
    </label>

    <label class="smrt-content-corrections-tool__field" data-smrt-part="field">
      {t(M['content.corrections_tool.public_note'])}
      <Textarea
        rows={3}
        bind:value={correctionPublicNote}
        placeholder={t(M['content.corrections_tool.optional_public_correction_note'])}
      ></Textarea>
    </label>

    <label class="smrt-content-corrections-tool__checkbox-row" data-smrt-part="field">
      <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
      <input type="checkbox" bind:checked={publishCorrection} />
      {t(M['content.corrections_tool.publish_immediately'])}
    </label>

    <Button
      variant="primary"
      type="button"
      disabled={busy || correctionSummary.trim().length === 0}
      onclick={() => void issueCorrection()}
    >
      {busy ? 'Issuing correction...' : 'Issue correction'}
    </Button>

    <div class="smrt-content-corrections-tool__list" data-smrt-part="list">
      <div class="smrt-content-corrections-tool__caption" data-smrt-part="caption">{t(M['content.corrections_tool.published_history'])}</div>
      {#if corrections.length === 0}
        <p class="smrt-content-corrections-tool__empty" data-smrt-part="empty">{t(M['content.corrections_tool.no_corrections_issued'])}</p>
      {:else}
        {#each corrections as correction (correction.id ?? `${correction.correctionType}-${correction.createdAt}`)}
          <div class="smrt-content-corrections-tool__card" data-smrt-part="card">
            <div class="smrt-content-corrections-tool__card-header" data-smrt-part="header">
              <strong>{correction.correctionType}</strong>
              <span class={`smrt-content-corrections-tool__pill smrt-content-corrections-tool__pill--${correction.status}`} data-smrt-part="badge">{correction.status}</span>
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  /* The tool lays itself out by its own width, not the viewport, so it
  fits a full page, a side panel, the assistant dock or a phone. */
  .smrt-content-corrections-tool__root {
    container-type: inline-size;
    container-name: governance-tool;
  }
  .smrt-content-corrections-tool__root,
  .smrt-content-corrections-tool__list,
  .smrt-content-corrections-tool__field {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-content-corrections-tool__card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.85rem;
  }
  .smrt-content-corrections-tool__card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .smrt-content-corrections-tool__card p {
    margin: 0;
  }
  .smrt-content-corrections-tool__checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }
  .smrt-content-corrections-tool__pill {
    padding: 0.2rem 0.55rem;
  }
  .smrt-content-corrections-tool__error,
  .smrt-content-corrections-tool__notice {
    margin: 0;
    padding: 0.75rem 0.9rem;
  }
  .smrt-content-corrections-tool__checkbox-row {
    min-height: 2.75rem;
  }
  @container governance-tool (max-width: 30rem) {
    .smrt-content-corrections-tool__root > :global(button) {
      width: 100%;
    }
    .smrt-content-corrections-tool__card-header {
      flex-wrap: wrap;
    }
  }
}

@layer smrt.theme {
  .smrt-content-corrections-tool__field {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-content-corrections-tool__card {
    background: var(--smrt-card-background, var(--smrt-color-surface));
    border: var(--smrt-card-border, var(--smrt-hairline));
    box-shadow: var(--smrt-card-shadow, none);
    border-radius: 0.75rem;
  }
  .smrt-content-corrections-tool__card span,
  .smrt-content-corrections-tool__empty,
  .smrt-content-corrections-tool__caption {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
  .smrt-content-corrections-tool__checkbox-row {
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-corrections-tool__pill {
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: capitalize;
  }
  .smrt-content-corrections-tool__pill--published,
  .smrt-content-corrections-tool__pill--neutral {
    background: color-mix(in srgb, var(--smrt-color-primary) 14%, transparent);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-content-corrections-tool__pill--draft,
  .smrt-content-corrections-tool__pill--retracted {
    background: color-mix(in srgb, var(--smrt-color-error) 14%, transparent);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-content-corrections-tool__error,
  .smrt-content-corrections-tool__notice {
    border-radius: 0.6rem;
    font-size: var(--smrt-typography-body-medium-size, 0.9rem);
  }
  .smrt-content-corrections-tool__error {
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-content-corrections-tool__notice {
    background: color-mix(in srgb, var(--smrt-color-primary) 10%, transparent);
    color: var(--smrt-color-on-primary-container);
  }
}

</style>
