<script lang="ts">
/**
 * smrt-reports' `saved-reports` widget (the Reports section page) over the
 * plan's sample data: the same component a generated app renders, given the
 * planner's in-browser reports transport, links and source labels.
 */
import { SavedReportsWidget } from '@happyvertical/smrt-reports/svelte';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { useDataSource } from '../data/context.ts';
import { appHref } from '../planner/app.svelte.ts';
import { plannerReportsFor } from '../reports/planner.ts';
import {
  PLANNER_REPORT_AUTHOR,
  REPORT_LIST_PATH,
  reportPath,
} from '../reports/store.ts';

interface Props {
  options?: Record<string, string | number | boolean | null>;
  title?: string;
  locale?: string;
}
let { options, title, locale }: Props = $props();
const reports = plannerReportsFor(useDataSource());
const currency = $derived(cookbookStore.settings().currency);
</script>

<SavedReportsWidget
  {options}
  {title}
  {locale}
  client={reports.client}
  reportHref={(id) => appHref(reportPath(id))}
  listHref={appHref(REPORT_LIST_PATH)}
  sources={reports.sourceInfo()}
  authorLabel={(id) => (id === PLANNER_REPORT_AUTHOR ? 'you' : undefined)}
  {currency}
/>
