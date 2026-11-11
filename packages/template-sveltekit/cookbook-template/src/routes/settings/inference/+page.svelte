<script lang="ts">
import InferenceSettingsPage from '@happyvertical/smrt-template-sveltekit/host/InferenceSettingsPage.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>
<InferenceSettingsPage {data} />
