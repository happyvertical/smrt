<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { MaterializedReportTable } from '@happyvertical/smrt-reports/svelte';
  import MaterializedReportDrilldown from '$lib/components/MaterializedReportDrilldown.svelte';
  import { Alert } from '@happyvertical/smrt-ui/feedback';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let details = $state<unknown>(undefined);
  let drilldownError = $state<string | null>(null);
  let loading = $state(false);
  let hydrated = $state(false);
  let requestSequence = 0;

  onMount(() => {
    hydrated = true;
  });

  async function drilldown(cell: { id: string; columnId: string }): Promise<void> {
    const request = ++requestSequence;
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
      const responseDetails = await response.json();
      if (request !== requestSequence) return;
      details = responseDetails;
    } catch {
      if (request !== requestSequence) return;
      drilldownError = 'Report drilldown unavailable';
    } finally {
      if (request === requestSequence) loading = false;
    }
  }

  async function changePage(page: number): Promise<void> {
    if (!Number.isSafeInteger(page) || page < 1) return;
    requestSequence += 1;
    details = undefined;
    drilldownError = null;
    loading = false;
    const offset = (page - 1) * data.page.limit;
    if (!Number.isSafeInteger(offset)) return;
    const url = new URL(window.location.href);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(data.page.limit));
    await goto(`${url.pathname}?${url.searchParams.toString()}`, {
      keepFocus: true,
      noScroll: true,
    });
  }
</script>

<svelte:head><title>{data.page.descriptor.reportClassName}</title></svelte:head>

<main class="page" data-materialized-report-hydrated={hydrated ? 'true' : 'false'}>
  <MaterializedReportTable
    page={{
      ...data.page,
      drilldownColumnIds: data.drilldownColumnIds,
    }}
    onDrilldown={drilldown}
    onPageChange={changePage}
    caption={data.page.descriptor.reportClassName}
  />

  {#if loading}
    <Alert variant="info" title="Loading report details">
      Loading the contributors for the selected amount.
    </Alert>
  {:else if drilldownError}
    <Alert variant="error" title="Report drilldown unavailable">
      {drilldownError}
    </Alert>
  {:else if details}
    <MaterializedReportDrilldown {details} />
  {/if}
</main>

<style>
  @layer smrt.theme {
    .page {
      display: grid;
      gap: var(--smrt-spacing-6);
      width: min(100%, 76rem);
      margin-inline: auto;
      padding: var(--smrt-spacing-6) var(--smrt-spacing-4);
    }
  }
</style>
