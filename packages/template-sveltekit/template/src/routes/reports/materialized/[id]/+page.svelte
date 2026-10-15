<script lang="ts">
  import { MaterializedReportTable } from '@happyvertical/smrt-reports/svelte';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();

  async function drilldown(cell: { id: string; columnId: string }): Promise<void> {
    await fetch(`/reports/materialized/${encodeURIComponent(data.hostId)}/drilldown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cell),
    });
  }
</script>

<main>
  <MaterializedReportTable
    page={{ descriptor: data.descriptor, ...data.page }}
    onDrilldown={drilldown}
    caption={data.descriptor.reportClassName}
  />
</main>
