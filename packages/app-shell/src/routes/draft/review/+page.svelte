<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { onMount } from 'svelte';
import { goto, invalidateAll } from '$app/navigation';
import ApprovalCard from '$lib/components/ApprovalCard.svelte';
import PublishPreview from '$lib/components/PublishPreview.svelte';
import { ApiError, api, decideApproval, isPendingApproval } from '$lib/ui/api';
import type {
  ApprovalView,
  DraftInfo,
  PendingApproval,
  PublishPreview as Preview,
} from '$lib/ui/types';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
let preview = $state<Preview | null>(null);
let name = $state('');
let approval = $state<ApprovalView | null>(null);
let busy = $state(false);
let error = $state('');
let reviewAgain = $state(false);

async function review() {
  busy = true;
  error = '';
  preview = null;
  approval = null;
  reviewAgain = false;
  try {
    const { data: out } = await api<{ draft: DraftInfo; preview: Preview }>(
      '/api/shell/draft/preview',
      { method: 'POST', body: {}, target: 'draft' },
    );
    name = out.draft.name;
    preview = out.preview;
  } catch (e) {
    error = e instanceof ApiError ? e.message : 'Could not review the draft.';
    reviewAgain = true;
  } finally {
    busy = false;
  }
}

async function publish() {
  if (!preview) return;
  busy = true;
  error = '';
  try {
    const { data: out } = await api<PendingApproval>(
      '/api/shell/draft/publish',
      {
        method: 'POST',
        body: { expect: preview.digest },
        target: 'draft',
      },
    );
    if (!isPendingApproval(out)) throw new Error('Expected a publish approval');
    // Use the actual stored approval, including its pinned preview and status.
    const { data: pending } = await api<{ approvals: ApprovalView[] }>(
      '/api/shell/approvals',
    );
    approval = pending.approvals.find((a) => a.id === out.approvalId) ?? null;
    if (!approval) await goto('/approvals');
  } catch (e) {
    error =
      e instanceof ApiError ? e.message : 'Could not request publication.';
    if (e instanceof ApiError && e.status === 409) reviewAgain = true;
  } finally {
    busy = false;
  }
}

async function decide(approve: boolean) {
  if (!approval) return;
  busy = true;
  error = '';
  try {
    const { data: out } = await decideApproval(approval.id, approve);
    if (out.status === 'failed') {
      error =
        out.error || 'The draft changed. Review it again before publishing.';
      reviewAgain = true;
      approval = { ...approval, status: 'failed', result: { error } };
    } else if (out.status === 'approved') {
      await goto('/', { invalidateAll: true });
      await invalidateAll();
    } else {
      approval = null;
      await review();
    }
  } catch (e) {
    error = e instanceof ApiError ? e.message : 'Could not send your decision.';
    reviewAgain = true;
  } finally {
    busy = false;
  }
}

onMount(() => {
  if (data.description?.draft) void review();
});
</script>

<svelte:head><title>Review and publish</title></svelte:head>
<div class="sh-page">
  <header class="sh-head"><h1>Review and publish{name ? `: ${name}` : ''}</h1></header>
  {#if !data.description?.draft}
    <p>No draft is open.</p>
    <Button href="/" variant="secondary">Back to app</Button>
  {:else}
    {#if error}<p class="sh-alert sh-alert-error" role="alert">{error}</p>{/if}
    {#if busy}<p role="status">Working…</p>{/if}
    {#if preview}<PublishPreview {preview} />{/if}
    {#if reviewAgain}
      <p>Review the latest draft before trying again.</p>
      <Button disabled={busy} onclick={review}>Review again</Button>
    {:else if approval}
      <ApprovalCard owner={data.session?.user} {approval} {busy} ondecide={decide} />
    {:else if preview}
      <Button disabled={busy} onclick={publish}>Publish</Button>
    {/if}
  {/if}
</div>
