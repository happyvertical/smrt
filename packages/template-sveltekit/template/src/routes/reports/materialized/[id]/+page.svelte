<script lang="ts">
  import { MaterializedReportTable } from '@happyvertical/smrt-reports/svelte';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  let details = $state<unknown>(undefined);
  let drilldownError = $state<string | null>(null);
  let loading = $state(false);

  async function drilldown(cell: { id: string; columnId: string }): Promise<void> {
    loading = true;
    drilldownError = null;
    details = undefined;
    try {
      const response = await fetch(`/reports/materialized/${encodeURIComponent(data.hostId)}/drilldown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cell),
      });
      if (!response.ok) throw new Error('Report drilldown unavailable');
      details = await response.json();
    } catch { drilldownError = 'Report drilldown unavailable'; }
    finally { loading = false; }
  }
</script>

<main>
  <MaterializedReportTable
    page={{ descriptor: data.descriptor, ...data.page }}
    onDrilldown={drilldown}
    caption={data.descriptor.reportClassName}
  />
  {#if loading}<p role="status">Loading report details…</p>{/if}
  {#if drilldownError}<p role="alert">{drilldownError}</p>{/if}
  {#if details}
    <section aria-label="Report drilldown"><pre>{JSON.stringify(details, null, 2)}</pre></section>
  {/if}
</main>
