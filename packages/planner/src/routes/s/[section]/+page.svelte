<script lang="ts">
import SectionPage from '$lib/components/SectionPage.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<SectionPage sectionId={data.sectionId} />
