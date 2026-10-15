<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from './messages.js';
import ReportResult from './ReportResult.svelte';
import { reportError, validReportResult } from './result.js';
import type {
  RuntimeReportResult,
  RuntimeReportsClient,
  SavedRuntimeReport,
} from './types.js';

export interface Props {
  id: string;
  client?: RuntimeReportsClient;
  locale?: string;
  currency?: string;
}
let { id, client, locale = 'en', currency = 'USD' }: Props = $props();
const { t } = useI18n();
let report = $state<SavedRuntimeReport | null>(null);
let result = $state<RuntimeReportResult | null>(null);
let error = $state<ReturnType<typeof reportError> | null>(null);
let loading = $state(false);
let revision = $state(0);
$effect(() => {
  const transport = client;
  const reportId = id;
  revision;
  let active = true;
  report = null;
  result = null;
  error = null;
  loading = !!transport;
  if (transport) {
    void (async () => {
      try {
        const saved = await transport.get(reportId);
        if (!active) return;
        report = saved;
        const value = await transport.run(reportId);
        if (!active) return;
        if (!validReportResult(value)) error = 'reports.invalid';
        else result = value;
      } catch (e) {
        if (active) error = reportError(e);
      } finally {
        if (active) loading = false;
      }
    })();
  }
  return () => {
    active = false;
  };
});
</script>

<section data-smrt-component="ReportDetail" aria-label={t(M['reports.title'])}>
  <h1>{report?.title ?? t(M['reports.title'])}</h1>
  {#if !client}
    <p>{t(M['reports.unavailable'])}</p>
  {:else}
    {#if report?.description}<p>{report.description}</p>{/if}
    <Button disabled={loading} onclick={() => revision++}>{t(M['reports.rerun'])}</Button>
    {#if loading}<p role="status">{t(M['reports.running'])}</p>{/if}
    {#if error}<p role="alert">{t(M[error])}</p>{/if}
    {#if result}<ReportResult {result} {locale} {currency} />{/if}
  {/if}
</section>
