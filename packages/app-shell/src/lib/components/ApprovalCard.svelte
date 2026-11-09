<script lang="ts">
import { describeApproval, failureText, statusLabel } from '$lib/ui/approvals';
import { fullTime, timeAgo } from '$lib/ui/format';
import type { ApprovalView } from '$lib/ui/types';

interface Props {
  approval: ApprovalView;
  /** Set while this card's decision is being sent. */
  busy?: boolean;
  /** Message from the last attempt on this card (404, 409, ...). */
  message?: string;
  ondecide?: (approve: boolean) => void;
}

let { approval, busy = false, message = '', ondecide }: Props = $props();

const detail = $derived(describeApproval(approval));
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

<article class="sh-card" aria-labelledby="{uid}-title">
  <header class="top">
    <h3 id="{uid}-title">{approval.summary}</h3>
    <span class="sh-badge {badge}">{statusLabel(approval.status)}</span>
  </header>

  {#each detail.lines as line, i (i)}
    <p class:warn={detail.destructive && i === detail.lines.length - 1}>{line}</p>
  {/each}

  {#each detail.blocks as block, i (i)}
    <p class="sh-muted" id="{uid}-code-{i}">Code for {block.title}</p>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling of long code) -->
    <pre class="sh-code" tabindex="0" aria-labelledby="{uid}-code-{i}"><code>{block.code}</code></pre>
  {/each}

  <p class="sh-muted">
    Asked <time datetime={approval.createdAt} title={fullTime(approval.createdAt)}
      >{timeAgo(approval.createdAt)}</time
    >{#if approval.requestedBy}
      by {approval.requestedBy}{/if}{#if !pending && approval.decidedAt}
      · {statusLabel(approval.status).toLowerCase()}
      <time datetime={approval.decidedAt} title={fullTime(approval.decidedAt)}
        >{timeAgo(approval.decidedAt)}</time
      >{#if approval.decidedBy}
        by {approval.decidedBy}{/if}{/if}
  </p>

  {#if failed}<p class="sh-alert sh-alert-error">{failed}</p>{/if}
  {#if message}<p class="sh-alert sh-alert-error" role="alert">{message}</p>{/if}

  {#if pending && ondecide}
    <div class="sh-actions">
      <button
        type="button"
        class="sh-btn sh-btn-primary"
        disabled={busy}
        onclick={() => ondecide(true)}
      >
        {busy ? 'Working…' : 'Approve'}<span class="sr-only">: {approval.summary}</span>
      </button>
      <button
        type="button"
        class="sh-btn"
        disabled={busy}
        onclick={() => ondecide(false)}
      >
        Deny<span class="sr-only">: {approval.summary}</span>
      </button>
    </div>
  {/if}
</article>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
  h3 {
    margin: 0;
    font-size: 1.0625rem;
  }
  p {
    margin: var(--smrt-spacing-sm, 0.5rem) 0;
  }
  .warn {
    font-weight: 600;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
</style>
