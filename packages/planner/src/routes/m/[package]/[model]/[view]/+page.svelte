<script lang="ts">
import ModelPage from '$lib/components/ModelPage.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<ModelPage
  packageId={data.packageId}
  modelName={data.modelName}
  view={data.view}
/>
