<script lang="ts">
import {
  type AssistantApprovalView,
  reconcileAssistantApprovalView,
} from '@happyvertical/smrt-chat/assistant-turn';
import {
  AssistantApprovalCard,
  type AssistantTransport,
} from '@happyvertical/smrt-chat/svelte';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { onMount, untrack } from 'svelte';
import { M } from '../../i18n/strings.settings.js';

let {
  approvals = [],
  transport,
  ondecided,
  onsettled,
}: {
  approvals?: AssistantApprovalView[];
  transport: AssistantTransport;
  ondecided?: () => void | Promise<void>;
  /** A known unsettled hold succeeded; invoked once before its card is removed. */
  onsettled?: () => void | Promise<void>;
} = $props();
const { t } = useI18n();
const titleId = $props.id();
let views = $state(untrack(() => approvals));
const knownUnsettled = new Set(
  untrack(() => approvals)
    .filter((row) => ['pending', 'approved', 'executing'].includes(row.status))
    .map((row) => row.id),
);
const notified = new Set<string>();
const canonicalViews = new Map(
  untrack(() => approvals).map((row) => [row.id, row]),
);
let disposed = false;
onMount(() => () => {
  disposed = true;
});
async function observe(rows: AssistantApprovalView[]) {
  if (disposed) return;
  // Retain only status already observed from the authorized loader/transport.
  rows = rows.map((row) => {
    const current = reconcileAssistantApprovalView(
      canonicalViews.get(row.id),
      row,
    );
    canonicalViews.set(row.id, current);
    return current;
  });
  for (const row of rows) {
    if (disposed) return;
    if (['pending', 'approved', 'executing'].includes(row.status))
      knownUnsettled.add(row.id);
    else {
      if (
        row.status === 'succeeded' &&
        knownUnsettled.has(row.id) &&
        !notified.has(row.id)
      ) {
        notified.add(row.id);
        try {
          await onsettled?.();
        } catch {
          /* Host refresh failures never change canonical approval state. */
        }
      }
    }
  }
  const current = rows.map((row) => canonicalViews.get(row.id) ?? row);
  if (!disposed) views = current;
  return current;
}
$effect(() => {
  const rows = approvals;
  untrack(() => {
    void observe(rows);
  });
});
const unsettled = $derived(
  views.filter((approval) =>
    ['pending', 'approved', 'executing'].includes(approval.status),
  ),
);
const hasUnsettled = $derived(unsettled.length > 0);
let pendingRead:
  | { source: AssistantTransport; request: Promise<AssistantApprovalView[]> }
  | undefined;
const readApprovals = $derived.by(() => {
  const source = transport;
  const list = source.listApprovals;
  if (!list) return;
  return async (threadId?: string) => {
    const current =
      pendingRead?.source === source
        ? pendingRead
        : { source, request: list.call(source, threadId) };
    pendingRead = current;
    try {
      return await current.request;
    } finally {
      if (pendingRead === current) pendingRead = undefined;
    }
  };
});
// Cards own polling while holds exist. Empty-list discovery shares their read.
const settingsTransport = $derived.by(() => {
  const source = transport;
  const list = readApprovals;
  const decide = source.decideApproval;
  return {
    ...source,
    sendMessage: source.sendMessage.bind(source),
    ...(list
      ? {
          listApprovals: async (threadId?: string) => {
            // All Settings cards use the same owner-wide list. A handoff from
            // discovery reuses an outstanding request instead of overlapping it.
            const rows = await list(threadId);
            return (await observe(rows)) ?? rows;
          },
        }
      : {}),
    ...(decide
      ? {
          decideApproval: async (id: string, approve: boolean) => {
            const next = await decide.call(source, id, approve);
            const rows = await observe([
              ...views.filter((view) => view.id !== next.id),
              next,
            ]);
            return rows?.find((view) => view.id === next.id) ?? next;
          },
        }
      : {}),
  } satisfies AssistantTransport;
});
$effect(() => {
  const list = readApprovals;
  if (!list || hasUnsettled) return;
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const discover = async () => {
    try {
      const rows = await list();
      if (active) await observe(rows);
    } catch {
      /* Retry transient discovery failures without exposing transport errors. */
    }
    if (active) timer = setTimeout(discover, 1000);
  };
  void discover();
  return () => {
    active = false;
    clearTimeout(timer);
  };
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
