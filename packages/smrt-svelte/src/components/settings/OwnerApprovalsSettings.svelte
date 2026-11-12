<script lang="ts">
import type { AssistantApprovalView } from '@happyvertical/smrt-chat/assistant-turn';
import {
  AssistantApprovalCard,
  type AssistantTransport,
} from '@happyvertical/smrt-chat/svelte';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { untrack } from 'svelte';
import { M } from '../../i18n/strings.settings.js';

let {
  approvals = [],
  transport,
  ondecided,
}: {
  approvals?: AssistantApprovalView[];
  transport: AssistantTransport;
  ondecided?: () => void | Promise<void>;
} = $props();
const { t } = useI18n();
const titleId = $props.id();
let views = $state(untrack(() => approvals));
$effect(() => {
  views = approvals;
});
const unsettled = $derived(
  views.filter((approval) =>
    ['pending', 'approved', 'executing'].includes(approval.status),
  ),
);
// Observe the existing card's authorized polling/decision calls; do not add a poller.
const settingsTransport = $derived.by(() => {
  const source = transport;
  const list = source.listApprovals;
  const decide = source.decideApproval;
  return {
    ...source,
    sendMessage: source.sendMessage.bind(source),
    ...(list
      ? {
          listApprovals: async (threadId?: string) => {
            const rows = await list.call(source, threadId);
            views = rows;
            return rows;
          },
        }
      : {}),
    ...(decide
      ? {
          decideApproval: async (id: string, approve: boolean) => {
            const next = await decide.call(source, id, approve);
            views = views.map((view) => (view.id === next.id ? next : view));
            return next;
          },
        }
      : {}),
  } satisfies AssistantTransport;
});
</script>

<section data-smrt-component="OwnerApprovalsSettings" aria-labelledby={titleId}>
  <h2 id={titleId}>{t(M['ui.settings.owner_approvals'])}</h2>
  {#each unsettled as approval (approval.id)}
    <AssistantApprovalCard {approval} transport={settingsTransport} {ondecided} />
  {:else}
    <p>{t(M['ui.settings.owner_approvals_empty'])}</p>
  {/each}
</section>
