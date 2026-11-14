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
  enabled: boolean;
  onsave: (enabled: boolean) => Promise<void>;
  approvals?: AssistantApprovalView[];
  transport?: AssistantTransport;
  ondecided?: () => void | Promise<void>;
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
