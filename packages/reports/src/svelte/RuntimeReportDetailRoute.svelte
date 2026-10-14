<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { onMount } from 'svelte';
import { getRuntimeReportsBrowserClient } from './browser-client.js';
import { M } from './messages.js';
import ReportDetail from './ReportDetail.svelte';
import type { RuntimeReportsClient } from './types.js';

export interface Props {
  id?: string;
  params?: { id?: string };
  client?: RuntimeReportsClient;
  serverAvailable?: boolean;
  /** Authenticated user id projected by the server route host. */
  currentUserId?: string;
  /** Opaque active tenant/session key used only to isolate browser hints. */
  clientScope?: string;
  /** Server-derived capability hint used by the shared session client. */
  canArchive?: boolean;
  locale?: string;
  currency?: string;
}
let {
  id,
  params,
  client,
  serverAvailable = true,
  currentUserId,
  clientScope,
  canArchive = false,
  locale,
  currency,
}: Props = $props();
const reportId = $derived(id ?? params?.id ?? '');
let browserClient = $state<RuntimeReportsClient | undefined>();
let mounted = $state(false);
const { t } = useI18n();
$effect(() => {
  browserClient = client;
  if (!client && mounted && serverAvailable) {
    browserClient = getRuntimeReportsBrowserClient({
      scopeKey: clientScope,
      currentUserId,
      canArchive,
    });
  }
});
onMount(() => {
  mounted = true;
  return () => {
    mounted = false;
  };
});
</script>

{#if serverAvailable && !browserClient}
  <p role="status">{t(M['reports.loading'])}</p>
{:else}
  <ReportDetail
    id={reportId}
    client={serverAvailable ? browserClient : undefined}
    {locale}
    {currency}
  />
{/if}
