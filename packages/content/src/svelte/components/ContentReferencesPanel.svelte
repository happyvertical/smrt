<script lang="ts">
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import type { Snippet } from 'svelte';
import type { ContentEditorReference } from '../content-editor-form';
import { M } from '../i18n.editor.js';

const { t } = useI18n();

export interface Props {
  referenceIds?: string[];
  references?: ContentEditorReference[];
  onReferenceIdsChange?: (referenceIds: string[]) => void;
  /**
   * Optional snippet rendered inside the panel beneath the references list
   * and the "add reference by ID" input. Host applications use this to inject
   * a richer picker (browsing a tenant asset pool, searching an external
   * archive, etc.) without forking the component. The snippet is responsible
   * for calling `onReferenceIdsChange` (or otherwise mutating the parent
   * state) when the user selects an entry.
   */
  children?: Snippet;
}

let {
  referenceIds = [],
  references = [],
  onReferenceIdsChange = undefined,
  children = undefined,
}: Props = $props();

let newReferenceId = $state('');

const visibleReferences = $derived(
  references.length
    ? references
    : referenceIds.map((id) => ({ id, title: id })),
);

function getReferenceLabel(reference: ContentEditorReference): string {
  return String(
    reference?.title ||
      reference?.name ||
      reference?.url ||
      reference?.source ||
      reference?.id ||
      'Reference',
  );
}

function getReferenceUrl(reference: ContentEditorReference): string {
  return String(
    reference?.url || reference?.originalUrl || reference?.source || '',
  );
}

function getSafeReferenceUrl(reference: ContentEditorReference): string {
  const url = getReferenceUrl(reference).trim();
  if (!url) {
    return '';
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

function addReference() {
  const id = newReferenceId.trim();
  if (!id || referenceIds.includes(id)) {
    return;
  }
  onReferenceIdsChange?.([...referenceIds, id]);
  newReferenceId = '';
}

function removeReference(id: string) {
  onReferenceIdsChange?.(
    referenceIds.filter((referenceId) => referenceId !== id),
  );
}
</script>

<div class="content-references-panel">
  {#if visibleReferences.length}
    <div class="reference-list">
      {#each visibleReferences as reference, index (reference.id || getSafeReferenceUrl(reference) || `${getReferenceLabel(reference)}-${index}`)}
        {@const safeUrl = getSafeReferenceUrl(reference)}
        {@const referenceId = typeof reference.id === 'string' ? reference.id : ''}
        <div class="reference-row">
          <div class="reference-copy">
            <strong>{getReferenceLabel(reference)}</strong>
            {#if safeUrl}
              <a href={safeUrl} target="_blank" rel="noreferrer">{safeUrl}</a>
            {/if}
          </div>
          {#if referenceId}
            <button type="button" onclick={() => removeReference(referenceId)}>Remove</button>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <p class="empty-state">{t(M['content.content_references_panel.no_references'])}</p>
  {/if}

  <div class="reference-input-row">
    <input
      type="text"
      aria-label={t(M['content.content_references_panel.add_reference_by_id_or_url'])}
      placeholder={t(M['content.content_references_panel.reference_id_or_url_placeholder'])}
      bind:value={newReferenceId}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          addReference();
        }
      }}
    />
    <button type="button" onclick={addReference}>Add</button>
  </div>

  {#if children}
    <div class="reference-extras">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .content-references-panel {
    display: grid;
    gap: 0.875rem;
    padding: 1rem;
    border: 1px dashed color-mix(in srgb, var(--smrt-color-outline) 45%, transparent);
    border-radius: 0.5rem;
  }

  .empty-state {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-style: italic;
  }

  .reference-list {
    display: grid;
    gap: 0.65rem;
  }

  .reference-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem;
    border: 1px solid color-mix(in srgb, var(--smrt-color-outline) 28%, transparent);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-low);
  }

  .reference-copy {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .reference-copy strong,
  .reference-copy a {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reference-copy strong {
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
  }

  .reference-copy a {
    color: var(--smrt-color-primary);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    text-decoration: none;
  }

  .reference-input-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
  }

  .reference-extras {
    display: grid;
    gap: 0.65rem;
  }

  input,
  button {
    min-height: 2.5rem;
    border: 1px solid color-mix(in srgb, var(--smrt-color-outline) 50%, transparent);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    font: inherit;
    padding: 0.55rem 0.875rem;
  }

  button {
    background: var(--smrt-color-surface-container);
    cursor: pointer;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  button:hover {
    background: var(--smrt-color-surface-container-high);
  }
</style>
