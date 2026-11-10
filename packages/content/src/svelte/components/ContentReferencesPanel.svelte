<script lang="ts">
import { Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import type { ContentEditorReference } from '../content-editor-form';
import { M } from '../i18n.editor.js';

const { t } = useI18n();

export interface Props {
  /** IDs of referenced content items. */
  referenceIds?: string[];
  /** Resolved reference objects with metadata for display. */
  references?: ContentEditorReference[];
  /** Invoked when the user adds or removes a reference. */
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

<div class="smrt-content-references-panel__root" data-smrt-component="ContentReferencesPanel">
  {#if visibleReferences.length}
    <div class="smrt-content-references-panel__list" data-smrt-part="list">
      {#each visibleReferences as reference, index (reference.id || getSafeReferenceUrl(reference) || `${getReferenceLabel(reference)}-${index}`)}
        {@const safeUrl = getSafeReferenceUrl(reference)}
        {@const referenceId = typeof reference.id === 'string' ? reference.id : ''}
        <div class="smrt-content-references-panel__row" data-smrt-part="row">
          <div class="smrt-content-references-panel__copy" data-smrt-part="copy">
            <strong>{getReferenceLabel(reference)}</strong>
            {#if safeUrl}
              <a href={safeUrl} target="_blank" rel="noreferrer">{safeUrl}</a>
            {/if}
          </div>
          {#if referenceId}
            <Button
              variant="ghost"
              type="button"
              class="reference-button"
              onclick={() => removeReference(referenceId)}>Remove</Button>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <p class="smrt-content-references-panel__empty" data-smrt-part="empty">{t(M['content.content_references_panel.no_references'])}</p>
  {/if}

  <div class="smrt-content-references-panel__input-row" data-smrt-part="input">
    <Input
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
    <Button
      variant="ghost"
      type="button"
      class="reference-button"
      onclick={addReference}>Add</Button>
  </div>

  {#if children}
    <div class="smrt-content-references-panel__extras" data-smrt-part="panel">
      {@render children()}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-content-references-panel__root {
    display: grid;
    gap: 0.875rem;
    padding: 1rem;
  }
  .smrt-content-references-panel__empty {
    margin: 0;
  }
  .smrt-content-references-panel__list {
    display: grid;
    gap: 0.65rem;
  }
  .smrt-content-references-panel__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem;
  }
  .smrt-content-references-panel__copy {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }
  .smrt-content-references-panel__copy strong,
  .smrt-content-references-panel__copy a {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-content-references-panel__input-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
  }
  .smrt-content-references-panel__extras {
    display: grid;
    gap: 0.65rem;
  }
  .smrt-content-references-panel__root :global(.reference-button) {
    min-height: 2.5rem;
    padding: 0.55rem 0.875rem;
    cursor: pointer;
  }
  /* Match the Input primitive's height/radius to the sibling reference-button so
  the two grid columns of .smrt-content-references-panel__input-row align (the primitive's base
  .input has no min-height). */
  .smrt-content-references-panel__root :global([data-smrt-component="Input"]) {
    min-height: 2.5rem;
  }
}

@layer smrt.theme {
  .smrt-content-references-panel__root {
    border: 1px dashed color-mix(in srgb, var(--smrt-color-outline) 45%, transparent);
    border-radius: 0.5rem;
  }
  .smrt-content-references-panel__empty {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-style: italic;
  }
  .smrt-content-references-panel__row {
    border: 1px solid color-mix(in srgb, var(--smrt-color-outline) 28%, transparent);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-content-references-panel__copy strong {
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
  }
  .smrt-content-references-panel__copy a {
    color: var(--smrt-color-primary);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    text-decoration: none;
  }
  .smrt-content-references-panel__root :global(.reference-button) {
    border: 1px solid color-mix(in srgb, var(--smrt-color-outline) 50%, transparent);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-references-panel__root :global(.reference-button:hover) {
    background: var(--smrt-color-surface-container-high);
  }
  /* Match the Input primitive's height/radius to the sibling reference-button so
  the two grid columns of .smrt-content-references-panel__input-row align (the primitive's base
  .input has no min-height). */
  .smrt-content-references-panel__root :global([data-smrt-component="Input"]) {
    border-radius: 0.5rem;
  }
}

</style>
