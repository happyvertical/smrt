<script lang="ts">
import { Checkbox } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import { M } from './messages.js';
import { reportError } from './result.js';
import type { RuntimeReportsClient, SavedRuntimeReport } from './types.js';

export interface Props {
  client?: RuntimeReportsClient;
  reportHref?: (id: string) => string;
  /** Host-owned identity projection; report transport never expands users. */
  authorLabel?: (userId: string) => string | undefined;
}
let {
  client,
  reportHref = (id) => `/reports/${encodeURIComponent(id)}`,
  authorLabel = (id) => id,
}: Props = $props();
const { t } = useI18n();
let onlyMine = $state(false);
let includeArchived = $state(false);
let rows = $state<SavedRuntimeReport[]>([]);
let loading = $state(false);
let error = $state<ReturnType<typeof reportError> | null>(null);
let refresh = $state(0);
let pending = $state<string | null>(null);
let epoch = 0;

$effect(() => {
  const transport = client;
  const options = { onlyMine, includeArchived };
  refresh;
  const current = ++epoch;
  rows = [];
  error = null;
  pending = null;
  loading = !!transport;
  if (transport) {
    void transport
      .list(options)
      .then((value) => {
        if (current === epoch) rows = value;
      })
      .catch((e) => {
        if (current === epoch) error = reportError(e);
      })
      .finally(() => {
        if (current === epoch) loading = false;
      });
  }
  return () => {
    ++epoch;
  };
});

async function archive(report: SavedRuntimeReport) {
  if (!client || pending || !report.canArchive) return;
  const current = epoch;
  pending = report.id;
  error = null;
  try {
    await client.archive(report.id, report.status !== 'archived');
    if (current === epoch) refresh = untrack(() => refresh) + 1;
  } catch (e) {
    if (current === epoch) error = reportError(e);
  } finally {
    if (current === epoch) pending = null;
  }
}
</script>

<section data-smrt-component="SavedReports" aria-label={t(M['reports.title'])}>
  <h1>{t(M['reports.title'])}</h1>
  {#if !client}
    <p>{t(M['reports.unavailable'])}</p>
  {:else}
    <div data-smrt-part="filters">
      <Checkbox bind:checked={onlyMine} label={t(M['reports.only_mine'])} />
      <Checkbox bind:checked={includeArchived} label={t(M['reports.archived'])} />
    </div>
    {#if error}<p role="alert">{t(M[error])}</p><Button onclick={() => refresh++}>{t(M['reports.retry'])}</Button>{/if}
    {#if loading}
      <p role="status">{t(M['reports.loading'])}</p>
    {:else if rows.length === 0 && !error}
      <p>{t(M['reports.empty'])}</p>
    {:else}
      <ul>
        {#each rows as report (report.id)}
          <li>
            <h2><a href={reportHref(report.id)}>{report.title}</a></h2>
            <dl>
              <dt>{t(M['reports.source'])}</dt><dd>{report.sourceId}</dd>
              <dt>{t(M['reports.author'])}</dt><dd>{authorLabel(report.createdByUserId) ?? report.createdByUserId}</dd>
            </dl>
            <p>{report.lastRunAt ? t(M['reports.last_run'], { time: report.lastRunAt }) : t(M['reports.never_run'])}</p>
            {#if report.canArchive}<Button disabled={pending !== null} onclick={() => archive(report)}>{t(M[report.status === 'archived' ? 'reports.unarchive' : 'reports.archive'])}</Button>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  [data-smrt-part='filters'] { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-3); }
  ul { display: grid; gap: var(--smrt-spacing-4); padding: 0; list-style: none; }
  li { padding: var(--smrt-spacing-4); border: var(--smrt-hairline); border-radius: var(--smrt-radius-medium); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: var(--smrt-spacing-2); }
}
</style>
