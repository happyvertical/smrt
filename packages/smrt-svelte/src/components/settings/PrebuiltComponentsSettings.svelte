<!--
  PrebuiltComponentsSettings: the Settings section that turns the prebuilt
  components on or off, lists owner approvals still pending
  (OwnerApprovalsSettings) and links to re-run onboarding.
-->
<script lang="ts">
import type { AssistantApprovalView } from '@happyvertical/smrt-chat/assistant-turn';
import { type AssistantTransport } from '@happyvertical/smrt-chat/svelte';
import { Toggle } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import { M } from '../../i18n/strings.onboarding.js';
import OwnerApprovalsSettings from './OwnerApprovalsSettings.svelte';

let {
  enabled,
  onsave,
  approvals = [],
  transport,
  ondecided,
  restartHref = '/onboarding?restart=1',
}: {
  /** Whether prebuilt components are currently turned on. */
  enabled: boolean;
  /** Persists the new setting; reject to put the toggle back and show an error. */
  onsave: (enabled: boolean) => Promise<void>;
  /** Server-loaded owner approvals still waiting on a decision. */
  approvals?: AssistantApprovalView[];
  /** Connection for deciding approvals; without it the approvals list is not shown. */
  transport?: AssistantTransport;
  /** Called after an owner decision is accepted, to refresh the page. */
  ondecided?: () => void | Promise<void>;
  /** Where "run onboarding again" goes. Default `/onboarding?restart=1`. */
  restartHref?: string;
} = $props();
const { t } = useI18n();
const titleId = $props.id();
let checked = $state(untrack(() => enabled));
let busy = $state(false);
let failed = $state(false);
$effect(() => {
  checked = enabled;
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
    <div class="smrt-prebuilt-components-settings__choice">
      <Toggle label={t(M['ui.onboarding.prebuilt_toggle'])} bind:checked disabled={busy} onchange={save} />
      <span role="status">{t(checked ? M['ui.onboarding.prebuilt_on'] : M['ui.onboarding.prebuilt_off'])}</span>
    </div>
    <Button variant="secondary" href={restartHref}>{t(M['ui.onboarding.restart'])}</Button>
    {#if failed}<p role="alert">{t(M['ui.onboarding.prebuilt_error'])}</p>{/if}
    {#if transport}
      <OwnerApprovalsSettings {approvals} {transport} {ondecided} />
    {/if}
  </Card>
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-prebuilt-components-settings__choice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-3);
    margin-block: var(--smrt-spacing-4);
  }
}

@layer smrt.theme {
  [role='alert'] {
    color: var(--smrt-color-error);
  }
}
</style>
