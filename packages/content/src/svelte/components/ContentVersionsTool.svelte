<script lang="ts">
import type { ContentVersionData } from '../../mock-smrt-client';
import { createClient } from '../../mock-smrt-client';
import { normalizeApiBaseUrl } from '../api';

export interface Props {
  apiBaseUrl?: string;
  contentId: string;
  onVersionsChange?: (versions: ContentVersionData[]) => void;
}

let {
  apiBaseUrl = '/api/v1',
  contentId,
  onVersionsChange = undefined,
}: Props = $props();

const client = $derived(createClient(normalizeApiBaseUrl(apiBaseUrl)));
const savedContentId = $derived(
  contentId && contentId !== 'new' ? contentId : null,
);

let versions = $state<ContentVersionData[]>([]);
let busy = $state(false);
let error = $state<string | null>(null);
let notice = $state<string | null>(null);
let loadedContentId = $state<string | null>(null);

$effect(() => {
  if (!savedContentId) {
    loadedContentId = null;
    versions = [];
    busy = false;
    error = null;
    notice = null;
    return;
  }

  if (savedContentId !== loadedContentId) {
    loadedContentId = savedContentId;
    versions = [];
    error = null;
    notice = null;
    void refreshVersions(savedContentId);
  }
});

function formatTimestamp(value: string | null | undefined) {
  if (!value) return 'Not published';
  return new Date(value).toLocaleString();
}

function getVersionProvenanceCopy(version: ContentVersionData) {
  const metadata = version.metadata || {};

  if (metadata.sourceCorrectionVersionNumber) {
    return `Generated from correction version v${metadata.sourceCorrectionVersionNumber}.`;
  }

  if (metadata.policyKey) {
    return `Created from the ${metadata.policyKey} review flow.`;
  }

  if (version.kind === 'publication') {
    return 'Frozen public transparency snapshot.';
  }

  return null;
}

async function refreshVersions(contentIdToLoad = savedContentId) {
  if (!contentIdToLoad) return;

  busy = true;
  error = null;

  try {
    const response = await client.contents.getVersions(contentIdToLoad);
    if (savedContentId !== contentIdToLoad) return;
    versions = response.data;
    onVersionsChange?.(response.data);
  } catch (err: any) {
    if (savedContentId !== contentIdToLoad) return;
    error = err.message || 'Failed to load versions';
  } finally {
    if (savedContentId === contentIdToLoad) {
      busy = false;
    }
  }
}

async function createSnapshot() {
  if (!savedContentId) return;

  const contentIdToSnapshot = savedContentId;
  busy = true;
  error = null;
  notice = null;

  try {
    await client.contents.createVersion(contentIdToSnapshot, {
      kind: 'manual',
      summary: 'Manual editorial snapshot',
    });
    if (savedContentId !== contentIdToSnapshot) return;
    notice = 'Snapshot created.';
    await refreshVersions(contentIdToSnapshot);
  } catch (err: any) {
    if (savedContentId !== contentIdToSnapshot) return;
    error = err.message || 'Failed to create version snapshot';
  } finally {
    if (savedContentId === contentIdToSnapshot) {
      busy = false;
    }
  }
}

async function restoreVersion(versionNumber: number) {
  if (!savedContentId) return;

  if (!confirm(`Restore content version ${versionNumber}?`)) {
    return;
  }

  const contentIdToRestore = savedContentId;
  busy = true;
  error = null;
  notice = null;

  try {
    await client.contents.restoreVersion(contentIdToRestore, versionNumber);
    if (savedContentId !== contentIdToRestore) return;
    notice = `Restored version ${versionNumber}.`;
    await refreshVersions(contentIdToRestore);
  } catch (err: any) {
    if (savedContentId !== contentIdToRestore) return;
    error = err.message || 'Failed to restore version';
  } finally {
    if (savedContentId === contentIdToRestore) {
      busy = false;
    }
  }
}
</script>

<div class="governance-tool">
  <div class="tool-toolbar">
    <button
      type="button"
      class="secondary-button"
      disabled={busy || !savedContentId}
      onclick={() => void createSnapshot()}
    >
      {busy ? 'Working...' : 'Create snapshot'}
    </button>
  </div>

  {#if error}
    <p class="tool-error">{error}</p>
  {/if}

  {#if notice}
    <p class="tool-notice">{notice}</p>
  {/if}

  {#if !savedContentId}
    <p class="empty-copy">Save this content to manage versions.</p>
  {:else if versions.length === 0}
    <p class="empty-copy">No versions saved yet.</p>
  {:else}
    <div class="tool-list">
      {#each versions as version (version.id ?? `version-${version.version ?? 0}`)}
        <div class="tool-card">
          <div class="tool-card-header">
            <strong>v{version.version}</strong>
            <span class="pill pill--neutral">{version.kind}</span>
          </div>
          <p>{version.summary || 'Snapshot saved'}</p>
          {#if getVersionProvenanceCopy(version)}
            <span>{getVersionProvenanceCopy(version)}</span>
          {/if}
          <div class="tool-card-footer">
            <span>{formatTimestamp(version.createdAt)}</span>
            <button
              type="button"
              class="secondary-button"
              disabled={busy || version.version === null || version.version === undefined}
              onclick={() => {
                if (version.version !== null && version.version !== undefined) {
                  void restoreVersion(version.version);
                }
              }}
            >
              Restore
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .governance-tool,
  .tool-list,
  .tool-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .tool-toolbar,
  .tool-card-header,
  .tool-card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .tool-toolbar {
    justify-content: flex-end;
  }

  .tool-card {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.75rem;
    padding: 0.85rem;
  }

  .tool-card p {
    margin: 0;
  }

  .tool-card span,
  .empty-copy {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.85rem;
  }

  .secondary-button {
    border-radius: 0.5rem;
    padding: 0.65rem 0.85rem;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    cursor: pointer;
    font-weight: 600;
  }

  .secondary-button:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }

  .pill {
    border-radius: 999px;
    padding: 0.2rem 0.55rem;
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: capitalize;
  }

  .pill--neutral {
    background: color-mix(in srgb, var(--smrt-color-primary) 14%, transparent);
    color: var(--smrt-color-on-primary-container);
  }

  .tool-error,
  .tool-notice {
    margin: 0;
    border-radius: 0.6rem;
    padding: 0.75rem 0.9rem;
    font-size: 0.9rem;
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
