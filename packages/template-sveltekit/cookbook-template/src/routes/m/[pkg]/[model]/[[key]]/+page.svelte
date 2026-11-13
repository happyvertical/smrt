<script lang="ts">
import CookbookModelPage from '@happyvertical/smrt-template-sveltekit/host/CookbookModelPage.svelte';
import { collectionDefinitions } from '@smrt/web';
import type { PageProps } from './$types';
let { data }: PageProps = $props();
</script>
<CookbookModelPage {data} {collectionDefinitions} />
