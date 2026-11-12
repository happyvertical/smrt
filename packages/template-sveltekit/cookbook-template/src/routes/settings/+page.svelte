<script lang="ts">
import {
  createAssistantHttpTransport,
} from '@happyvertical/smrt-chat/svelte';
import { ShellSettingsPage } from '@happyvertical/smrt-svelte/app';
import {
  ConnectAi,
  createConnectAiClient,
} from '@happyvertical/smrt-svelte/connect-ai';
import { OwnerApprovalsSettings } from '@happyvertical/smrt-svelte/settings';
import { signOut } from '@happyvertical/smrt-template-sveltekit/host/sveltekit-client';
import { Toggle } from '@happyvertical/smrt-ui/forms';
import { defineMessages, useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { invalidateAll } from '$app/navigation';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
const M = defineMessages({
  'cookbook.settings.template': 'Start over from a template',
});
const { t } = useI18n();
const client = createConnectAiClient({ endpoint: '/api/connect-ai' });
let busy = $state(false);
let message = $state('');
const transport = createAssistantHttpTransport({ endpoint: '/api/assistant' });
</script>

<svelte:head>
  <title>Settings · My app</title>
</svelte:head>

<!-- Appearance, account, and layout; preferences persist through the shell storageKey. -->
<ShellSettingsPage onSignOut={signOut}>
  <OwnerApprovalsSettings approvals={data.approvals} {transport} ondecided={invalidateAll} onsettled={invalidateAll} />
  <Button href="/onboarding?restart=1">{t(M['cookbook.settings.template'])}</Button>
  <ConnectAi {client} variant="settings" apiKeyHref="/settings/inference" />
  <Toggle label="Pre-built components" checked={data.prebuilt.enabled} disabled={busy} onchange={async enabled => {
    busy = true;
    message = '';
    try {
      const response = await fetch('/api/cookbook/prebuilt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled, revision: data.prebuilt.revision }) });
      if (!response.ok) throw new Error('The setting could not be saved.');
      await invalidateAll();
    } catch { message = 'The setting could not be saved. Refresh and try again.'; }
    finally { busy = false; }
  }} />
  {#if message}<p role="alert">{message}</p>{/if}
</ShellSettingsPage>
