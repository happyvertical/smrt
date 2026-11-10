<script lang="ts">
import PackagePage from '$lib/components/PackagePage.svelte';
import { humanize } from '$lib/data/format.ts';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{humanize(data.id)} · smrt planner</title>
</svelte:head>

<PackagePage id={data.id} />
