<script lang="ts">
import { invalidate } from '$app/navigation';
import ApprovalCard from '$lib/components/ApprovalCard.svelte';
import { ApiError, decideApproval } from '$lib/ui/api';
import { splitApprovals } from '$lib/ui/approvals';
import { DEPENDS } from '$lib/ui/events';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const groups = $derived(splitApprovals(data.approvals));
let busyId = $state('');
let messages: Record<string, string> = $state({});
let status = $state('');

async function decide(id: string, summary: string, approve: boolean) {
  busyId = id;
  messages = { ...messages, [id]: '' };
  status = '';
  try {
    const { data: out } = await decideApproval(id, approve);
    if (out.status === 'failed') {
      messages = {
        ...messages,
        [id]: out.error || 'The change was approved but could not be applied.',
      };
      status = `Approved, but it failed: ${summary}`;
    } else {
      status = `${approve ? 'Approved' : 'Denied'}: ${summary}`;
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      messages = { ...messages, [id]: 'This request no longer exists.' };
    } else if (e instanceof ApiError && e.status === 409) {
      messages = {
        ...messages,
        [id]: `${e.message}. The list has been refreshed.`,
      };
    } else {
      messages = {
        ...messages,
        [id]:
          e instanceof ApiError ? e.message : 'Could not send your decision.',
      };
    }
    status = messages[id];
  } finally {
    busyId = '';
    await Promise.all([
      invalidate(DEPENDS.approvals),
      invalidate(DEPENDS.shell),
    ]);
  }
}
</script>

<svelte:head><title>Approvals</title></svelte:head>

<div class="sh-page" data-smrt-component="AppShellApprovals">
  <header class="sh-head" data-smrt-part="header">
    <div>
      <h1>Approvals</h1>
      <p class="sh-sub" data-smrt-part="description">Risky changes wait here until you decide.</p>
    </div>
  </header>

  <p class="smrt-app-shell-approvals__sr-only" role="status" aria-live="polite" data-smrt-part="label">{status}</p>

  <section aria-labelledby="pending-h">
    <h2 id="pending-h">
      Waiting for you{#if groups.pending.length} ({groups.pending.length}){/if}
    </h2>
    {#if groups.pending.length === 0}
      <div class="sh-empty" data-smrt-part="empty"><p class="sh-muted" data-smrt-part="description">Nothing is waiting for a decision.</p></div>
    {:else}
      <div aria-live="polite">
        {#each groups.pending as approval (approval.id)}
          <ApprovalCard
            {approval}
            busy={busyId === approval.id}
            message={messages[approval.id]}
            ondecide={(approve) => decide(approval.id, approval.summary, approve)}
          />
        {/each}
      </div>
    {/if}
  </section>

  {#if groups.decided.length}
    <section aria-labelledby="decided-h" class="smrt-app-shell-approvals__decided" data-smrt-part="section">
      <h2 id="decided-h">Decided</h2>
      {#each groups.decided as approval (approval.id)}
        <ApprovalCard {approval} />
      {/each}
    </section>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-app-shell-approvals__decided {
    margin-block-start: var(--smrt-spacing-2xl, 2rem);
  }
  .smrt-app-shell-approvals__sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

@layer smrt.theme {
  h2 {
    font-size: 1.125rem;
  }
}
</style>
