<script lang="ts">
/**
 * The `saved-reports` overview widget: the Reports section page's default
 * (`sectionDefault`), the team's saved reports as cards with their headline
 * figures, "New report" (asks the page's assistant) and a hint. It reads
 * through the shared browser client of the app's runtime-report routes; a
 * host with its own transport (the planner's sample data) passes `client`.
 */
import { onMount } from 'svelte';
import { getRuntimeReportsBrowserClient } from './browser-client.js';
import type { ReportSourceInfo } from './describe.js';
import SavedReports from './SavedReports.svelte';
import type { RuntimeReportsClient } from './types.js';

export interface Props {
  /** The widget's options from the host's layout; `limit` (a positive number) caps the cards shown, default 6. */
  options?: Record<string, string | number | boolean | null>;
  /** The widget's heading as set in the host's layout. This widget does not render it; the host places it. */
  title?: string;
  /** BCP 47 locale for dates, numbers and relative times; default `en`. */
  locale?: string;
  /** A host-owned transport; omitted, the app's shared browser client. */
  client?: RuntimeReportsClient;
  /** The page of one report by id; default `/reports/<id>`. */
  reportHref?: (id: string) => string;
  /** The Saved reports page ("View all"); default `/reports`. */
  listHref?: string;
  /** The report sources by label and fields (`reports.runtime.sources`), for each card's description line. */
  sources?: readonly ReportSourceInfo[];
  /** Host-owned identity projection naming who saved a report; report transport never expands users. */
  authorLabel?: (userId: string) => string | undefined;
  /** ISO 4217 code that formats currency measures; default `USD`. */
  currency?: string;
}
let {
  options = {},
  locale = 'en',
  client,
  reportHref,
  listHref = '/reports',
  sources,
  authorLabel,
  currency,
}: Props = $props();
let shared = $state<RuntimeReportsClient | undefined>();
onMount(() => {
  if (!client) shared = getRuntimeReportsBrowserClient();
});
const limit = $derived(
  typeof options.limit === 'number' && options.limit > 0 ? options.limit : 6,
);
</script>

<div data-smrt-component="SavedReportsWidget">
  <SavedReports
    variant="section"
    client={client ?? shared}
    {limit}
    {reportHref}
    {listHref}
    {sources}
    {authorLabel}
    {locale}
    {currency}
  />
</div>
