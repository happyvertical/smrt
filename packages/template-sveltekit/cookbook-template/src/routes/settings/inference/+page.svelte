<script lang="ts">
import InferenceSettingsPage from '@happyvertical/smrt-template-sveltekit/host/InferenceSettingsPage.svelte';
import { defineMessages, useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { page } from '$app/state';
import type { PageProps } from './$types';

const M = defineMessages({ 'cookbook.onboarding.return': 'Back to setup' });
const { t } = useI18n();
let { data }: PageProps = $props();
</script>
<InferenceSettingsPage {data} />

{#if (data.onboarding && !data.onboarding.completed) || page.url.searchParams.get('returnTo') === 'onboarding'}<Button href="/onboarding">{t(M['cookbook.onboarding.return'])}</Button>{/if}
