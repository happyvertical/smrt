<script lang="ts">
import { Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from './messages.js';
import { reportError } from './result.js';
import type { RuntimeReportsClient, SavedRuntimeReport } from './types.js';

export interface Props {
  client?: RuntimeReportsClient;
  reportId?: string;
  measure?: string;
  dimension?: string;
  onchange: (value: {
    reportId: string;
    measure: string;
    dimension: string;
  }) => void;
}
let {
  client,
  reportId = '',
  measure = '',
  dimension = '',
  onchange,
}: Props = $props();
const { t } = useI18n();
let reports = $state<SavedRuntimeReport[]>([]);
let loading = $state(false);
let error = $state<ReturnType<typeof reportError> | null>(null);
const selected = $derived(reports.find((r) => r.id === reportId));
$effect(() => {
  const transport = client;
  let active = true;
  reports = [];
  error = null;
  loading = !!transport;
  if (transport)
    void transport
      .list({ onlyMine: false, includeArchived: false })
      .then((rows) => {
        if (active) reports = rows;
      })
      .catch((e) => {
        if (active) error = reportError(e);
      })
      .finally(() => {
        if (active) loading = false;
      });
  return () => {
    active = false;
  };
});
</script>

<div data-smrt-component="ReportPicker">
  {#if !client}<p>{t(M['reports.unavailable'])}</p>
  {:else}
    {#if loading}<p role="status">{t(M['reports.loading'])}</p>{/if}
    {#if error}<p role="alert">{t(M[error])}</p>{/if}
    <Select aria-label={t(M['reports.select_report'])} value={reportId} disabled={loading || !!error} onchange={event => onchange({ reportId: event.currentTarget.value, measure: '', dimension: '' })}>
      <option value="">{t(M['reports.choose_report'])}</option>
      {#each reports as report (report.id)}<option value={report.id}>{report.title}</option>{/each}
    </Select>
    <Select aria-label={t(M['reports.select_measure'])} value={measure} disabled={!selected} onchange={event => onchange({ reportId, measure: event.currentTarget.value, dimension })}>
      <option value="">{t(M['reports.choose_measure'])}</option>
      {#each selected?.spec.measures ?? [] as m (m.as)}<option value={m.as}>{m.as}</option>{/each}
    </Select>
    <Select aria-label={t(M['reports.select_dimension'])} value={dimension} disabled={!selected} onchange={event => onchange({ reportId, measure, dimension: event.currentTarget.value })}>
      <option value="">{t(M['reports.choose_dimension'])}</option>
      {#each selected?.spec.dimensions ?? [] as d (d.as)}<option value={d.as}>{d.as}</option>{/each}
    </Select>
  {/if}
</div>
