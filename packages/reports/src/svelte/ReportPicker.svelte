<script lang="ts">
import { FormGroup, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { describeReport, type ReportSourceInfo } from './describe.js';
import { M } from './messages.js';
import { reportError } from './result.js';
import type { RuntimeReportsClient, SavedRuntimeReport } from './types.js';

export interface Props {
  client?: RuntimeReportsClient;
  reportId?: string;
  measure?: string;
  dimension?: string;
  /** The report sources by label and fields, for measure and grouping names. */
  sources?: readonly ReportSourceInfo[];
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
  sources = [],
  onchange,
}: Props = $props();
const { t } = useI18n();
let reports = $state<SavedRuntimeReport[]>([]);
let loading = $state(false);
let error = $state<ReturnType<typeof reportError> | null>(null);
const selected = $derived(reports.find((r) => r.id === reportId));
const named = $derived.by(() => {
  if (!selected) return { measures: [], dimensions: [] };
  const source = sources.find((s) => s.id === selected.sourceId);
  const describe = (spec: typeof selected.spec) =>
    describeReport(spec, { t, locale: 'en', currency: 'USD', source });
  const measures = describe(selected.spec).measures.map((label, i) => ({
    value: selected.spec.measures[i]?.as ?? '',
    label,
  }));
  const dimensions = selected.spec.dimensions.map((d) => ({
    value: d.as,
    label: describe({ ...selected.spec, dimensions: [d] }).groupings,
  }));
  return { measures, dimensions };
});
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

<div class="report-picker" data-smrt-component="ReportPicker">
  {#if !client}<p>{t(M['reports.unavailable'])}</p>
  {:else}
    {#if loading}<p role="status">{t(M['reports.loading'])}</p>{/if}
    {#if error}<p role="alert">{t(M[error])}</p>{/if}
    <FormGroup label={t(M['reports.select_report'])}>
      <Select value={reportId} disabled={loading || !!error} onchange={event => onchange({ reportId: event.currentTarget.value, measure: '', dimension: '' })}>
        <option value="">{t(M['reports.choose_report'])}</option>
        {#each reports as report (report.id)}<option value={report.id}>{report.title}</option>{/each}
      </Select>
    </FormGroup>
    <FormGroup label={t(M['reports.select_measure'])}>
      <Select value={measure} disabled={!selected} onchange={event => onchange({ reportId, measure: event.currentTarget.value, dimension })}>
        <option value="">{t(M['reports.choose_measure'])}</option>
        {#each named.measures as m (m.value)}<option value={m.value}>{m.label}</option>{/each}
      </Select>
    </FormGroup>
    <FormGroup label={t(M['reports.select_dimension'])}>
      <Select value={dimension} disabled={!selected} onchange={event => onchange({ reportId, measure, dimension: event.currentTarget.value })}>
        <option value="">{t(M['reports.choose_dimension'])}</option>
        {#each named.dimensions as d (d.value)}<option value={d.value}>{d.label}</option>{/each}
      </Select>
    </FormGroup>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .report-picker { display: grid; gap: var(--smrt-spacing-3); }
  .report-picker > p { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-small-size); }
}
</style>
