<script lang="ts">
import { AssistantApprovalCard } from '@happyvertical/smrt-chat/svelte';
import { Button } from '@happyvertical/smrt-ui';
import { describeApproval, failureText, statusLabel } from '$lib/ui/approvals';
import {
  authorName,
  fullTime,
  type OwnerProfile,
  timeAgo,
} from '$lib/ui/format';
import type { ApprovalView } from '$lib/ui/types';

interface Props {
  approval: ApprovalView;
  owner?: OwnerProfile | null;
  /** Set while this card's decision is being sent. */
  busy?: boolean;
  /** Message from the last attempt on this card (404, 409, ...). */
  message?: string;
  ondecide?: (approve: boolean) => void;
}

let {
  approval,
  owner = null,
  busy = false,
  message = '',
  ondecide,
}: Props = $props();

const description = $derived(describeApproval(approval));
const failed = $derived(failureText(approval));
const pending = $derived(approval.status === 'pending');
const uid = $derived(`ap-${approval.id}`);
const badge = $derived(
  approval.status === 'approved'
    ? 'sh-badge-ok'
    : approval.status === 'pending'
      ? 'sh-badge-warn'
      : 'sh-badge-bad',
);
</script>

<AssistantApprovalCard presentation={{
  id: approval.id, summary: approval.summary,
  statusLabel: statusLabel(approval.status), badgeClass: badge,
  pending, busy, message, ondecide, busyLabel: 'Working…', headingSize: '1.0625rem',
}}>
{#snippet detail()}
  {#each description.lines as line, i (i)}
    <p class:warn={description.destructive && i === description.lines.length - 1}>{line}</p>
  {/each}

  {#each description.blocks as block, i (i)}
    <p class="sh-muted" id="{uid}-code-{i}">Code for {block.title}</p>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling of long code) -->
    <pre class="sh-code" tabindex="0" aria-labelledby="{uid}-code-{i}"><code>{block.code}</code></pre>
  {/each}

  <p class="sh-muted">
    Asked <time datetime={approval.createdAt} title={fullTime(approval.createdAt)}
      >{timeAgo(approval.createdAt)}</time
    >{#if approval.requestedBy}
      {' by '}{authorName(approval.requestedBy, owner)}{/if}{#if !pending && approval.decidedAt}
      · {statusLabel(approval.status).toLowerCase()}
      <time datetime={approval.decidedAt} title={fullTime(approval.decidedAt)}
        >{timeAgo(approval.decidedAt)}</time
      >{#if approval.decidedBy}
        {' by '}{authorName(approval.decidedBy, owner)}{/if}{/if}
  </p>

  {#if failed}<p class="sh-alert sh-alert-error">{failed}</p>{/if}
  {#if approval.status === 'failed' && approval.action?.kind === 'publish-draft'}
    <Button variant="secondary" href="/draft/review">Review again</Button>
  {/if}
{/snippet}
</AssistantApprovalCard>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  p {
    margin: var(--smrt-spacing-sm, 0.5rem) 0;
  }
  .warn {
    font-weight: 600;
  }

}
</style>
