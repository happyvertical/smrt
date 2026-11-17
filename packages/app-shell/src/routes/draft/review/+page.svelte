<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { onMount } from 'svelte';
import { goto, invalidateAll } from '$app/navigation';
import PublishPreview from '$lib/components/PublishPreview.svelte';
import { ApiError, api } from '$lib/ui/api';
import type { DraftInfo, PublishPreview as Preview } from '$lib/ui/types';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
let preview = $state<Preview | null>(null);
let name = $state('');
let busy = $state(false);
let error = $state('');
let reviewAgain = $state(false);
let published = $state(false);

async function review() {
  busy = true;
  error = '';
  preview = null;
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

// The owner's own click publishes in one step, pinned to the digest of the
// preview on screen; a draft that changed since is refused (409) and the
// page asks for a fresh review.
async function publish() {
  if (!preview) return;
  busy = true;
  error = '';
  try {
    const { data: out } = await api<{ status: string; error?: string }>(
      '/api/shell/draft/publish',
      {
        method: 'POST',
        body: { expect: preview.digest },
        target: 'draft',
      },
    );
    if (out.status !== 'approved')
      throw new Error(out.error || 'Could not publish.');
    published = true;
    await goto('/', { invalidateAll: true });
    await invalidateAll();
  } catch (e) {
    error =
      e instanceof ApiError || e instanceof Error
        ? e.message
        : 'Could not publish.';
    reviewAgain = true;
  } finally {
    busy = false;
  }
}

onMount(() => {
  if (data.description?.draft) void review();
});
</script>

<svelte:head><title>Review draft</title></svelte:head>
<div class="smrt-app-shell__page">
  <header class="smrt-app-shell__head"><h1>Review your draft{name ? `: ${name}` : ''}</h1></header>
  {#if !data.description?.draft}
    <p>No draft is open.</p>
    <Button href="/" variant="secondary">Back to app</Button>
  {:else}
    {#if error}<p class="smrt-app-shell__alert smrt-app-shell__alert-error" role="alert">{error}</p>{/if}
    {#if published}<p role="status">Published. Opening your app…</p>
    {:else if busy}<p role="status">{preview ? 'Publishing…' : 'Reviewing your draft…'}</p>{/if}
    {#if preview}
      <PublishPreview {preview}>
        {#snippet actions()}
          {#if reviewAgain}
            <p>Review the latest draft before trying again.</p>
            <Button disabled={busy} onclick={review}>Review again</Button>
          {:else}
            <Button disabled={busy} onclick={publish}>{busy ? 'Publishing…' : 'Publish'}</Button>
          {/if}
        {/snippet}
      </PublishPreview>
    {:else if reviewAgain}
      <p>Review the latest draft before trying again.</p>
      <Button disabled={busy} onclick={review}>Review again</Button>
    {/if}
  {/if}
</div>
