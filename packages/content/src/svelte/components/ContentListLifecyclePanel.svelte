<script lang="ts">
import type {
  DataSurfaceActionResult,
  DataSurfaceRowId,
} from '@happyvertical/smrt-ui/data';
import { Modal } from '@happyvertical/smrt-ui/feedback';
import { Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy, untrack } from 'svelte';
import {
  type ContentListLifecycleActionId,
  type ContentListLifecycleBinding,
  type ContentListLifecycleSnapshot,
  type ContentListRestoreStatus,
  createContentListLifecycleController,
} from '../content-list-lifecycle.js';
import type { ContentListDataQueryRequest } from '../content-list-query.js';
import { M } from '../i18n.contribution.js';

const { t } = useI18n();

interface Props {
  binding: ContentListLifecycleBinding;
  mode: 'active' | 'trash';
  selectedRowIds: DataSurfaceRowId[];
  query?: ContentListDataQueryRequest;
  queryFingerprint?: string;
  exactMatchingCount?: number;
  viewKey: string;
  oncomplete: (result: DataSurfaceActionResult) => void;
}

let {
  binding,
  mode,
  selectedRowIds,
  query = undefined,
  queryFingerprint = undefined,
  exactMatchingCount = undefined,
  viewKey,
  oncomplete,
}: Props = $props();

let controller = createContentListLifecycleController(untrack(() => binding));
let snapshot = $state<ContentListLifecycleSnapshot>(controller.snapshot());
let lastResult = $state<ContentListLifecycleSnapshot['summary']>();
let dialogOpen = $state(false);
let countConfirmation = $state('');
let restoreStatus = $state<ContentListRestoreStatus>('draft');
let intent = $state<'selected' | 'all-matching'>('selected');

let unsubscribe = controller.subscribe((next) => {
  snapshot = next;
});

function sameBindingAuthority(
  left: ContentListLifecycleBinding,
  right: ContentListLifecycleBinding,
): boolean {
  return (
    left.client === right.client &&
    left.client.preview === right.client.preview &&
    left.client.apply === right.client.apply &&
    left.revision === right.revision &&
    left.maxSelectionSize === right.maxSelectionSize &&
    left.identity?.kind === right.identity?.kind &&
    left.identity?.surfaceId === right.identity?.surfaceId &&
    left.identity?.subject?.type === right.identity?.subject?.type &&
    left.identity?.subject?.id === right.identity?.subject?.id
  );
}

let installedBinding = untrack(() => binding);

function replaceController(nextBinding: ContentListLifecycleBinding): void {
  unsubscribe();
  controller.reset();
  controller = createContentListLifecycleController(nextBinding);
  snapshot = controller.snapshot();
  lastResult = undefined;
  dialogOpen = false;
  countConfirmation = '';
  unsubscribe = controller.subscribe((next) => {
    snapshot = next;
  });
}

$effect(() => {
  const nextBinding = binding;
  if (sameBindingAuthority(installedBinding, nextBinding)) return;
  replaceController(nextBinding);
  installedBinding = nextBinding;
});

onDestroy(() => unsubscribe());

$effect(() => {
  controller.invalidate(viewKey);
  if (snapshot.status === 'idle') {
    dialogOpen = false;
    countConfirmation = '';
  }
});

const busy = $derived(
  snapshot.status === 'previewing' ||
    snapshot.status === 'applying' ||
    snapshot.replayRequired === true,
);
const selectedCount = $derived(selectedRowIds.length);
const selectionLimit = $derived(binding.maxSelectionSize ?? 200);
const matchingSelectionTooLarge = $derived(
  exactMatchingCount !== undefined && exactMatchingCount > selectionLimit,
);
const resolvedCount = $derived(snapshot.summary?.resolvedCount ?? 0);
const requiresTypedCount = $derived(snapshot.actionId === 'permanent-delete');
const confirmationValid = $derived(
  !requiresTypedCount || countConfirmation.trim() === String(resolvedCount),
);

function selectionFor(scope: 'selected' | 'all-matching') {
  return scope === 'selected'
    ? { scope: 'explicit-ids' as const, rowIds: [...selectedRowIds] }
    : {
        scope: 'all-matching' as const,
        queryFingerprint: queryFingerprint ?? '',
      };
}

async function begin(
  actionId: ContentListLifecycleActionId,
  scope: 'selected' | 'all-matching' = 'selected',
) {
  intent = scope;
  countConfirmation = '';
  dialogOpen = true;
  await controller.preview({
    actionId,
    selection: selectionFor(scope),
    expectedCount:
      scope === 'selected' ? selectedCount : (exactMatchingCount ?? -1),
    ...(scope === 'all-matching' && query ? { query } : {}),
    ...(actionId === 'restore' ? { restoreStatus } : {}),
    viewKey,
  });
}

async function apply() {
  const next = await controller.apply(resolvedCount);
  if (next.status !== 'succeeded' || !next.result) return;
  lastResult = next.summary;
  oncomplete(next.result);
}

function close() {
  if (busy) return;
  dialogOpen = false;
  controller.reset();
}

function retryPreview() {
  if (!snapshot.actionId) return;
  void begin(snapshot.actionId, intent);
}
</script>

<section
  class="lifecycle"
  aria-label={mode === 'trash'
    ? t(M['content.content_list.trash_actions'])
    : t(M['content.content_list.lifecycle_actions'])}
>
  {#if mode === 'active'}
    <Button
      variant="ghost"
      size="sm"
      type="button"
      disabled={selectedCount === 0 || busy}
      onclick={() => begin('move-to-trash')}
    >{t(M['content.content_list.move_selected_to_trash'])}</Button>
  {:else}
    <Select
      aria-label={t(M['content.content_list.restore_destination'])}
      bind:value={restoreStatus}
      disabled={busy || dialogOpen}
    >
      <option value="draft">{t(M['content.content_list.restore_as_draft'])}</option>
      <option value="review">{t(M['content.content_list.restore_for_review'])}</option>
      <option value="published">{t(M['content.content_list.restore_and_publish'])}</option>
    </Select>
    <Button
      variant="ghost"
      size="sm"
      type="button"
      disabled={selectedCount === 0 || busy}
      onclick={() => begin('restore')}
    >{t(M['content.content_list.restore_selected'])}</Button>
    <Button
      variant="ghost"
      size="sm"
      type="button"
      disabled={selectedCount === 0 || busy}
      onclick={() => begin('permanent-delete')}
    >{t(M['content.content_list.delete_selected_permanently'])}</Button>
    <Button
      variant="ghost"
      size="sm"
      type="button"
      disabled={exactMatchingCount === undefined || exactMatchingCount === 0 || matchingSelectionTooLarge || !query || !queryFingerprint || busy}
      onclick={() => begin('permanent-delete', 'all-matching')}
    >{t(M['content.content_list.empty_trash'])}</Button>
  {/if}
</section>
{#if mode === 'trash' && matchingSelectionTooLarge}
  <p class="selection-limit" role="status">
    {t(M['content.content_list.empty_trash_limit'], { count: selectionLimit })}
  </p>
{/if}
{#if lastResult}
  <div class="lifecycle-result" aria-live="polite">
    <p>
      {t(M['content.content_list.lifecycle_completed_summary'], {
        accepted: lastResult.accepted,
        skipped: lastResult.skipped,
        failed: lastResult.failed,
        reference: lastResult.auditReference,
      })}
    </p>
    {#if lastResult.skipped > 0 || lastResult.failed > 0}
      <ul aria-label={t(M['content.content_list.lifecycle_exceptions'])}>
        {#each lastResult.outcomes.filter((outcome) => outcome.status !== 'accepted') as outcome}
          <li>{String(outcome.rowId)}: {outcome.reason ?? outcome.status}</li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<Modal
  open={dialogOpen}
  title={snapshot.actionId === 'permanent-delete'
    ? t(M['content.content_list.permanent_delete_title'])
    : snapshot.actionId === 'restore'
      ? t(M['content.content_list.restore_title'])
      : t(M['content.content_list.move_to_trash_title'])}
  size="md"
  closeOnBackdrop={!busy}
  closeOnEscape={!busy}
  showClose={!busy}
  onClose={close}
  ariaDescribedBy="content-lifecycle-summary"
>
  <div class="preview" aria-live="polite" aria-busy={busy}>
    {#if snapshot.status === 'previewing'}
      <p id="content-lifecycle-summary">
        {t(M['content.content_list.lifecycle_resolving'])}
      </p>
    {:else if snapshot.status === 'applying'}
      <p role="status">
        {t(M['content.content_list.workflow_applying'])}
      </p>
      {#if snapshot.summary}
        <p id="content-lifecycle-summary">
          {t(M['content.content_list.lifecycle_resolved'], {
            count: snapshot.summary.resolvedCount,
          })}
        </p>
      {/if}
    {:else if snapshot.summary}
      <p id="content-lifecycle-summary">
        {t(M['content.content_list.lifecycle_resolved'], {
          count: snapshot.summary.resolvedCount,
        })}
      </p>
      {#if snapshot.summary.representativeLabels.length > 0}
        <p>{t(M['content.content_list.lifecycle_examples'], {
          examples: snapshot.summary.representativeLabels.join(', '),
        })}</p>
      {/if}
      <p>
        {t(M['content.content_list.lifecycle_eligibility'], {
          accepted: snapshot.summary.accepted,
          skipped: snapshot.summary.skipped,
          failed: snapshot.summary.failed,
        })}
      </p>
      {#if snapshot.actionId === 'permanent-delete'}
        <p>{t(M['content.content_list.permanent_delete_warning'], {
          count: snapshot.summary.resolvedCount,
        })}</p>
        <Input
          aria-label={t(M['content.content_list.permanent_delete_count_label'])}
          inputmode="numeric"
          autocomplete="off"
          bind:value={countConfirmation}
          disabled={busy || snapshot.status !== 'ready'}
        />
      {/if}
    {/if}

    {#if snapshot.error}
      <p class="error" role="alert">{snapshot.error}</p>
    {/if}
    {#if snapshot.status === 'succeeded' && snapshot.summary}
      <p role="status">
        {t(M['content.content_list.lifecycle_completed_audit'], {
          reference: snapshot.summary.auditReference,
        })}
      </p>
      {#if snapshot.summary.skipped > 0 || snapshot.summary.failed > 0}
        <ul aria-label={t(M['content.content_list.lifecycle_exceptions'])}>
          {#each snapshot.summary.outcomes.filter((outcome) => outcome.status !== 'accepted') as outcome}
            <li>{String(outcome.rowId)}: {outcome.reason ?? outcome.status}</li>
          {/each}
        </ul>
      {/if}
    {/if}

    <div class="actions">
      <Button variant="ghost" type="button" disabled={busy} onclick={close}>
        {snapshot.status === 'succeeded'
          ? t(M['content.content_list.lifecycle_close'])
          : t(M['content.content_list.cancel'])}
      </Button>
      {#if snapshot.status === 'failed' && snapshot.renewalRequired}
        <Button type="button" onclick={retryPreview}>
          {t(M['content.content_list.lifecycle_renew_preview'])}
        </Button>
      {:else if snapshot.status === 'failed'}
        <Button type="button" onclick={apply}>
          {t(M['content.content_list.retry'])}
        </Button>
      {:else if snapshot.status === 'ready'}
        <Button
          type="button"
          disabled={!confirmationValid || resolvedCount === 0}
          onclick={apply}
        >{t(M['content.content_list.lifecycle_confirm_count'], {
          count: resolvedCount,
        })}</Button>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .lifecycle,
  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .preview {
    display: grid;
    gap: 0.75rem;
  }

  .preview p {
    margin: 0;
  }

  .lifecycle-result p {
    margin: 0.5rem 0 0;
  }

  .selection-limit {
    margin: 0.5rem 0 0;
  }

  .actions {
    justify-content: flex-end;
    margin-top: 0.5rem;
  }

  .error {
    color: var(--smrt-color-error, #b3261e);
  }
</style>
