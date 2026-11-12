<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import { onMount, type Snippet, untrack } from 'svelte';
import {
  type AssistantApprovalRequest,
  type AssistantApprovalView,
  reconcileAssistantApprovalView,
} from '../../../assistant-turn-events.js';
import { M } from '../../i18n.js';
import type { AssistantTransport } from './assistant-transport.js';

export interface Props {
  approval?: AssistantApprovalRequest;
  threadId?: string;
  toolPresentation?: 'generic';
  transport?: AssistantTransport;
  /** Host-authorized presentation for an existing decision endpoint and persisted view. */
  presentation?: {
    id: string;
    summary: string;
    statusLabel: string;
    badgeClass: string;
    headingSize?: string;
    pending: boolean;
    busy?: boolean;
    busyLabel?: string;
    message?: string;
    ondecide?: (approve: boolean) => void;
  };
  detail?: Snippet;
  ondecided?: () => void | Promise<void>;
}
const {
  approval,
  threadId,
  transport,
  ondecided,
  presentation,
  toolPresentation,
  detail,
}: Props = $props();
const { t } = useI18n();
let view = $state<AssistantApprovalView>(
  untrack(() => ({
    id: approval?.id ?? '',
    tool: approval?.tool ?? '',
    callId: approval?.callId ?? '',
    summary: approval?.summary ?? '',
    ...(approval?.presentation ? { presentation: approval.presentation } : {}),
    status: 'pending',
  })),
);
let busy = $state(false);
let error = $state(false);
let verified = $state(false);
const labels = {
  pending: M['chat.approval.pending'],
  approved: M['chat.approval.approved'],
  denied: M['chat.approval.denied'],
  expired: M['chat.approval.expired'],
  executing: M['chat.approval.executing'],
  succeeded: M['chat.approval.succeeded'],
  failed: M['chat.approval.failed'],
};

onMount(() => {
  if (presentation || !approval || !transport) return;
  const boundTransport = transport;
  const boundThread = threadId;
  const boundApproval = approval;
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const refresh = async () => {
    try {
      const rows = await boundTransport.listApprovals?.(boundThread);
      if (!active) return;
      const current = rows?.find((row) => row.id === boundApproval.id);
      if (current) {
        view = reconcileAssistantApprovalView(view, current);
        verified = true;
      }
    } catch {
      if (active) error = true;
    }
    if (active && ['pending', 'approved', 'executing'].includes(view.status))
      timer = setTimeout(refresh, 1000);
  };
  void refresh();
  return () => {
    active = false;
    clearTimeout(timer);
  };
});

async function decide(approve: boolean) {
  if (
    busy ||
    !verified ||
    view.status !== 'pending' ||
    !approval ||
    !transport?.decideApproval
  )
    return;
  busy = true;
  error = false;
  try {
    view = reconcileAssistantApprovalView(
      view,
      await transport.decideApproval(approval.id, approve),
    );
    await ondecided?.();
  } catch {
    error = true;
  } finally {
    busy = false;
  }
}
</script>

{#if presentation}
<article class="sh-card" data-smrt-component="AssistantApprovalCard" aria-labelledby="ap-{presentation.id}-title" style:--smrt-approval-heading-size={presentation.headingSize ?? 'var(--smrt-typography-title-medium-size)'}>
  <header class="top">
    <h3 id="ap-{presentation.id}-title">{presentation.summary}</h3>
    <span class="sh-badge {presentation.badgeClass}">{presentation.statusLabel}</span>
  </header>
  {@render detail?.()}
  {#if presentation.message}<p class="sh-alert sh-alert-error" role="alert">{presentation.message}</p>{/if}
  {#if presentation.pending && presentation.ondecide}
    <div class="sh-actions">
      <Button labelWhitespace="trim" class="sh-btn sh-btn-primary" disabled={presentation.busy} aria-label={`${presentation.busy ? (presentation.busyLabel ?? t(M['chat.approval.pending'])) : t(M['chat.approval.approve'])}: ${presentation.summary}`} onclick={() => presentation.ondecide?.(true)}>{presentation.busy ? (presentation.busyLabel ?? t(M['chat.approval.pending'])) : t(M['chat.approval.approve'])}</Button>
      <Button labelWhitespace="trim" class="sh-btn" variant="secondary" disabled={presentation.busy} aria-label={`${t(M['chat.approval.deny'])}: ${presentation.summary}`} onclick={() => presentation.ondecide?.(false)}>{t(M['chat.approval.deny'])}</Button>
    </div>
  {/if}
</article>
{:else if approval && transport}
<div data-smrt-component="AssistantApprovalCard">
<Card padding="sm">
  <div class="approval" aria-busy={busy}>
    <p>{toolPresentation === 'generic' ? view.presentation?.summary ?? t(M['chat.approval.review_change']) : view.summary}</p>
    <p role="status" aria-live="polite">{t(labels[view.status])}</p>
    {#if view.status === 'pending' && transport.decideApproval && transport.listApprovals}
      <div class="actions">
        <Button disabled={busy || !verified} onclick={() => decide(true)}>{t(M['chat.approval.approve'])}</Button>
        <Button variant="secondary" disabled={busy || !verified} onclick={() => decide(false)}>{t(M['chat.approval.deny'])}</Button>
      </div>
    {:else if !transport?.decideApproval || !transport.listApprovals}
      <p>{t(M['chat.approval.unavailable'])}</p>
    {/if}
    {#if error}<p role="alert">{t(M['chat.approval.error'])}</p>{/if}
  </div>
</Card>
</div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
.top { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--smrt-spacing-2); }
.top h3 { margin: 0; font-size: var(--smrt-approval-heading-size); }
.approval { display: grid; gap: var(--smrt-spacing-2); color: var(--smrt-color-on-surface); }
.approval p { margin: var(--smrt-spacing-0); }
.actions { display: flex; gap: var(--smrt-spacing-2); flex-wrap: wrap; }
}
</style>
