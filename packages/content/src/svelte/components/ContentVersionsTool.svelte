<script lang="ts">
import { ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ContentVersionData } from '../../mock-smrt-client';
import { createClient } from '../../mock-smrt-client';
import { normalizeApiBaseUrl } from '../api';
import { M } from '../i18n.tools.js';

const { t } = useI18n();

export interface Props {
  /** Base URL for content API requests. */
  apiBaseUrl?: string;
  /** ID of the content item to retrieve versions for. */
  contentId: string;
  /** Invoked when the versions list changes. */
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
  } catch (err) {
    if (savedContentId !== contentIdToLoad) return;
    error =
      (err instanceof Error ? err.message : '') || 'Failed to load versions';
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
  } catch (err) {
    if (savedContentId !== contentIdToSnapshot) return;
    error =
      (err instanceof Error ? err.message : '') ||
      'Failed to create version snapshot';
  } finally {
    if (savedContentId === contentIdToSnapshot) {
      busy = false;
    }
  }
}

let pendingRestoreVersion = $state<number | null>(null);

function requestRestoreVersion(versionNumber: number) {
  if (!savedContentId) return;
  pendingRestoreVersion = versionNumber;
}

function cancelRestoreVersion() {
  pendingRestoreVersion = null;
}

function confirmRestoreVersion() {
  const versionNumber = pendingRestoreVersion;
  pendingRestoreVersion = null;
  if (versionNumber !== null) {
    void restoreVersion(versionNumber);
  }
}

async function restoreVersion(versionNumber: number) {
  if (!savedContentId) return;

  const contentIdToRestore = savedContentId;
  busy = true;
  error = null;
  notice = null;

  try {
    await client.contents.restoreVersion(contentIdToRestore, versionNumber);
    if (savedContentId !== contentIdToRestore) return;
    notice = `Restored version ${versionNumber}.`;
    await refreshVersions(contentIdToRestore);
  } catch (err) {
    if (savedContentId !== contentIdToRestore) return;
    error =
      (err instanceof Error ? err.message : '') || 'Failed to restore version';
  } finally {
    if (savedContentId === contentIdToRestore) {
      busy = false;
    }
  }
}
</script>

<div class="smrt-content-versions-tool__root" data-smrt-component="ContentVersionsTool">
  <div class="smrt-content-versions-tool__toolbar" data-smrt-part="actions">
    <Button
      variant="secondary"
      type="button"
      disabled={busy || !savedContentId}
      onclick={() => void createSnapshot()}
    >
      {busy ? 'Working...' : 'Create snapshot'}
    </Button>
  </div>

  {#if error}
    <p class="smrt-content-versions-tool__error" role="alert" aria-live="assertive" data-smrt-part="error">{error}</p>
  {/if}

  {#if notice}
    <p class="smrt-content-versions-tool__notice" role="status" aria-live="polite" data-smrt-part="status">{notice}</p>
  {/if}

  {#if !savedContentId}
    <p class="smrt-content-versions-tool__empty" data-smrt-part="empty">{t(M['content.versions_tool.save_to_manage_versions'])}</p>
  {:else if versions.length === 0}
    <p class="smrt-content-versions-tool__empty" data-smrt-part="empty">{t(M['content.versions_tool.no_versions_saved'])}</p>
  {:else}
    <div class="smrt-content-versions-tool__list" data-smrt-part="list">
      {#each versions as version (version.id ?? `version-${version.version ?? 0}`)}
        <div class="smrt-content-versions-tool__card" data-smrt-part="item">
          <div class="smrt-content-versions-tool__header" data-smrt-part="header">
            <strong>v{version.version}</strong>
            <span class="smrt-content-versions-tool__pill smrt-content-versions-tool__pill--neutral" data-smrt-part="badge">{version.kind}</span>
          </div>
          <p>{version.summary || 'Snapshot saved'}</p>
          {#if getVersionProvenanceCopy(version)}
            <span>{getVersionProvenanceCopy(version)}</span>
          {/if}
          <div class="smrt-content-versions-tool__footer" data-smrt-part="footer">
            <span>{formatTimestamp(version.createdAt)}</span>
            <Button
              variant="secondary"
              type="button"
              disabled={busy || version.version === null || version.version === undefined}
              onclick={() => {
                if (version.version !== null && version.version !== undefined) {
                  requestRestoreVersion(version.version);
                }
              }}
            >
              Restore
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<ConfirmDialog
  open={pendingRestoreVersion !== null}
  title={t(M['content.versions_tool.restore_confirm_title'])}
  message={t(M['content.versions_tool.restore_confirm_message'], {
    version: pendingRestoreVersion ?? '',
  })}
  confirmLabel={t(M['content.versions_tool.restore_confirm_action'])}
  cancelLabel={t(M['content.versions_tool.restore_confirm_cancel'])}
  onconfirm={confirmRestoreVersion}
  oncancel={cancelRestoreVersion}
/>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  /* The tool lays itself out by its own width, not the viewport, so it
  fits a full page, a side panel, the assistant dock or a phone. */
  .smrt-content-versions-tool__root {
    container-type: inline-size;
    container-name: governance-tool;
  }
  .smrt-content-versions-tool__root,
  .smrt-content-versions-tool__list,
  .smrt-content-versions-tool__card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-content-versions-tool__toolbar,
  .smrt-content-versions-tool__header,
  .smrt-content-versions-tool__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .smrt-content-versions-tool__toolbar {
    justify-content: flex-end;
  }
  .smrt-content-versions-tool__card {
    padding: 0.85rem;
  }
  .smrt-content-versions-tool__card p {
    margin: 0;
  }
  .smrt-content-versions-tool__pill {
    padding: 0.2rem 0.55rem;
  }
  .smrt-content-versions-tool__error,
  .smrt-content-versions-tool__notice {
    margin: 0;
    padding: 0.75rem 0.9rem;
  }
  @container governance-tool (max-width: 30rem) {
    .smrt-content-versions-tool__toolbar {
      justify-content: stretch;
    }
    .smrt-content-versions-tool__toolbar :global(button),
    .smrt-content-versions-tool__footer :global(button) {
      width: 100%;
    }
    .smrt-content-versions-tool__footer {
      flex-direction: column;
      align-items: stretch;
    }
  }
}

@layer smrt.theme {
  .smrt-content-versions-tool__card {
    background: var(--smrt-card-background, var(--smrt-color-surface));
    border: var(--smrt-card-border, var(--smrt-hairline));
    box-shadow: var(--smrt-card-shadow, none);
    border-radius: 0.75rem;
  }
  .smrt-content-versions-tool__card span,
  .smrt-content-versions-tool__empty {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
  .smrt-content-versions-tool__pill {
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: capitalize;
  }
  .smrt-content-versions-tool__pill--neutral {
    background: color-mix(in srgb, var(--smrt-color-primary) 14%, transparent);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-content-versions-tool__error,
  .smrt-content-versions-tool__notice {
    border-radius: 0.6rem;
    font-size: var(--smrt-typography-body-medium-size, 0.9rem);
  }
  .smrt-content-versions-tool__error {
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-content-versions-tool__notice {
    background: color-mix(in srgb, var(--smrt-color-primary) 10%, transparent);
    color: var(--smrt-color-on-primary-container);
  }
}

</style>
