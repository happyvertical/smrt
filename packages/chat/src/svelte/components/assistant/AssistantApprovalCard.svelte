<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import { onMount, untrack } from 'svelte';
import type {
  AssistantApprovalRequest,
  AssistantApprovalView,
} from '../../../assistant-turn-events.js';
import { M } from '../../i18n.js';
import type { AssistantTransport } from './assistant-transport.js';

export interface Props {
  approval: AssistantApprovalRequest;
  threadId: string;
  transport: AssistantTransport;
  ondecided?: () => void | Promise<void>;
}
const { approval, threadId, transport, ondecided }: Props = $props();
const { t } = useI18n();
let view = $state<AssistantApprovalView>(
  untrack(() => ({ ...approval, status: 'pending' })),
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
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const refresh = async () => {
    try {
      const rows = await transport.listApprovals?.(threadId);
      if (!active) return;
      const current = rows?.find((row) => row.id === approval.id);
      if (current) {
        view = current;
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
    !transport.decideApproval
  )
    return;
  busy = true;
  error = false;
  try {
    view = await transport.decideApproval(approval.id, approve);
    await ondecided?.();
  } catch {
    error = true;
  } finally {
    busy = false;
  }
}
</script>

<div data-smrt-component="AssistantApprovalCard">
<Card padding="sm">
  <div class="approval" aria-busy={busy}>
    <p>{view.summary}</p>
    <p role="status" aria-live="polite">{t(labels[view.status])}</p>
    {#if view.status === 'pending' && transport.decideApproval && transport.listApprovals}
      <div class="actions">
        <Button disabled={busy || !verified} onclick={() => decide(true)}>{t(M['chat.approval.approve'])}</Button>
        <Button variant="secondary" disabled={busy || !verified} onclick={() => decide(false)}>{t(M['chat.approval.deny'])}</Button>
      </div>
    {:else if !transport.decideApproval || !transport.listApprovals}
      <p>{t(M['chat.approval.unavailable'])}</p>
    {/if}
    {#if error}<p role="alert">{t(M['chat.approval.error'])}</p>{/if}
  </div>
</Card>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
.approval { display: grid; gap: var(--smrt-spacing-2); color: var(--smrt-color-on-surface); }
.approval p { margin: var(--smrt-spacing-0); }
.actions { display: flex; gap: var(--smrt-spacing-2); flex-wrap: wrap; }
}
</style>
