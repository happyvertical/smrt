<script lang="ts">
import { createAssistantHttpTransport } from '@happyvertical/smrt-chat/svelte';
import { createConnectAiClient } from '@happyvertical/smrt-svelte/connect-ai';
import {
  createOnboardingClient,
  FirstRunOnboarding,
} from '@happyvertical/smrt-svelte/onboarding';
import { defineMessages, useI18n } from '@happyvertical/smrt-ui/i18n';
import { goto, invalidateAll } from '$app/navigation';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
const M = defineMessages({
  'cookbook.onboarding.title': 'Welcome',
  'cookbook.onboarding.description':
    'Your own app for the work and people that matter to you.',
});
const { t } = useI18n();
const client = createOnboardingClient({ endpoint: '/api/onboarding' });
const connectAi = createConnectAiClient({ endpoint: '/api/connect-ai' });
const approvalTransport = createAssistantHttpTransport({
  endpoint: '/api/assistant',
});
</script>
<svelte:head><title>{t(M['cookbook.onboarding.title'])} · My app</title></svelte:head>
{#if data.onboarding}
  <FirstRunOnboarding {client} {connectAi} {approvalTransport} initialState={data.onboarding} appName="My app" description={t(M['cookbook.onboarding.description'])} apiKeyHref="/settings/inference?returnTo=onboarding" oncomplete={async () => { await invalidateAll(); await goto('/'); }} />
{/if}
