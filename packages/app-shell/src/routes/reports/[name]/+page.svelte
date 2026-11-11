<script lang="ts">
import { ReportResult } from '@happyvertical/smrt-reports/svelte';
import { invalidate } from '$app/navigation';
import { DEPENDS } from '$lib/ui/events';
import {
  reportApi,
  reportCell,
  reportCellHref,
  reportWords,
} from '$lib/ui/reports';
import { targetPath } from '$lib/ui/target';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>
<svelte:head><title>{data.report.label ?? data.report.spec.title}</title></svelte:head>
<div class="sh-page">
  <header class="sh-head"><div><h1>{data.report.label ?? data.report.spec.title}</h1><p class="sh-sub">{data.report.description ?? data.report.spec.description ?? ''}</p></div>
    <div class="sh-actions"><button class="sh-btn" onclick={() => invalidate(DEPENDS.records)}>Run again</button><a class="sh-btn" href={targetPath(`${reportApi(data.name)}/csv`, data.target)}>Download CSV</a><a class="sh-btn" href="/reports">All reports</a></div>
  </header>
  <p>{reportWords(data.report, data.description?.models ?? {})}</p>
  {#if data.problem}<p class="sh-alert sh-alert-error" role="alert">{data.problem}</p><a href="/reports">Back to reports</a>
  {:else if data.result}<ReportResult result={data.result} spec={data.report.spec} variant="full" formatCell={reportCell} cellHref={reportCellHref} />{/if}
</div>
