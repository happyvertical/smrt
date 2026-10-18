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
  options?: Record<string, string | number | boolean | null>;
  title?: string;
  locale?: string;
  /** A host-owned transport; omitted, the app's shared browser client. */
  client?: RuntimeReportsClient;
  reportHref?: (id: string) => string;
  /** The Saved reports page ("View all"); default `/reports`. */
  listHref?: string;
  sources?: readonly ReportSourceInfo[];
  authorLabel?: (userId: string) => string | undefined;
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
