<script lang="ts">
  import { RuntimeReportsRoute } from '@happyvertical/smrt-reports/svelte';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
</script>

<svelte:head><title>Reports</title></svelte:head>
<main>
  <RuntimeReportsRoute
    currentUserId={data.currentUserId}
    currentUserLabel={data.currentUserLabel}
    clientScope={data.clientScope}
    canArchive={data.canArchive}
  />
</main>
