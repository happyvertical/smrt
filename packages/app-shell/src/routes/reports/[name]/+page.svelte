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
<div class="smrt-app-shell__page">
  <header class="smrt-app-shell__head"><div><h1>{data.report.label ?? data.report.spec.title}</h1><p class="smrt-app-shell__sub">{data.report.description ?? data.report.spec.description ?? ''}</p></div>
    <div class="smrt-app-shell__actions"><button class="smrt-app-shell__btn" onclick={() => invalidate(DEPENDS.records)}>Run again</button><a class="smrt-app-shell__btn" href={targetPath(`${reportApi(data.name)}/csv`, data.target)} aria-describedby={data.result?.truncated ? 'report-csv-sample' : undefined}>{data.result?.truncated ? 'Download bounded sample CSV' : 'Download CSV'}</a><a class="smrt-app-shell__btn" href="/reports">All reports</a></div>
  </header>
  {#if data.result?.truncated}<p id="report-csv-sample" class="smrt-app-shell__muted">The CSV contains the same capped sample as this report, not all matching records.</p>{/if}
  <p>{reportWords(data.report, data.description?.models ?? {})}</p>
  {#if data.problem}<p class="smrt-app-shell__alert smrt-app-shell__alert-error" role="alert">{data.problem}</p><a href="/reports">Back to reports</a>
  {:else if data.result}<ReportResult result={data.result} spec={data.report.spec} variant="full" formatCell={reportCell} cellHref={reportCellHref} />{/if}
</div>
