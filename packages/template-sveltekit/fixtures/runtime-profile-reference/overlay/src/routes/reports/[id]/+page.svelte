<script lang="ts">
  import { RuntimeReportDetailRoute } from '@happyvertical/smrt-reports/svelte';
  import { page } from '$app/state';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
</script>

<svelte:head><title>Report detail</title></svelte:head>
<main>
  <RuntimeReportDetailRoute
    id={page.params.id}
    currentUserId={data.currentUserId}
    clientScope={data.clientScope}
    canArchive={data.canArchive}
  />
</main>
