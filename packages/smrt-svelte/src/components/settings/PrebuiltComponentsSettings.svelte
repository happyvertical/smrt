<script lang="ts">
import type { AssistantApprovalView } from '@happyvertical/smrt-chat/assistant-turn';
import {
  AssistantApprovalCard,
  type AssistantTransport,
} from '@happyvertical/smrt-chat/svelte';
import { Toggle } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import { M } from '../../i18n/strings.onboarding.js';

let {
  enabled,
  onsave,
  approvals = [],
  transport,
  ondecided,
  restartHref = '/onboarding?restart=1',
}: {
  enabled: boolean;
  onsave: (enabled: boolean) => Promise<void>;
  approvals?: AssistantApprovalView[];
  transport: AssistantTransport;
  ondecided?: () => void | Promise<void>;
  restartHref?: string;
} = $props();
const { t } = useI18n();
const titleId = $props.id();
let checked = $state(untrack(() => enabled));
let busy = $state(false);
let failed = $state(false);
let views = $state(untrack(() => approvals));
$effect(() => {
  checked = enabled;
});
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
async function save(next: boolean) {
  busy = true;
  failed = false;
  const previous = enabled;
  try {
    await onsave(next);
  } catch {
    checked = previous;
    failed = true;
  } finally {
    busy = false;
  }
}
</script>

<section data-smrt-component="PrebuiltComponentsSettings" aria-labelledby={titleId} aria-busy={busy}>
  <Card>
    <h2 id={titleId}>{t(M['ui.onboarding.prebuilt'])}</h2>
    <p>{t(M['ui.onboarding.prebuilt_hint'])}</p>
    <div class="choice">
      <Toggle label={t(M['ui.onboarding.prebuilt_toggle'])} bind:checked disabled={busy} onchange={save} />
      <span role="status">{t(checked ? M['ui.onboarding.prebuilt_on'] : M['ui.onboarding.prebuilt_off'])}</span>
    </div>
    <Button variant="secondary" href={restartHref}>{t(M['ui.onboarding.restart'])}</Button>
    {#if failed}<p role="alert">{t(M['ui.onboarding.prebuilt_error'])}</p>{/if}
    {#each unsettled as approval (approval.id)}
      <AssistantApprovalCard {approval} transport={settingsTransport} {ondecided} />
    {/each}
  </Card>
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .choice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--smrt-spacing-3); margin-block: var(--smrt-spacing-4); }
  [role='alert'] { color: var(--smrt-color-error); }
}
</style>
