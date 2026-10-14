<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { onMount } from 'svelte';
import { getRuntimeReportsBrowserClient } from './browser-client.js';
import { M } from './messages.js';
import SavedReports from './SavedReports.svelte';
import type { RuntimeReportsClient } from './types.js';

export interface Props {
  client?: RuntimeReportsClient;
  serverAvailable?: boolean;
  /** Authenticated user id projected by the server route host. */
  currentUserId?: string;
  /** Opaque active tenant/session key used only to isolate browser hints. */
  clientScope?: string;
  /** Display label for the authenticated user; other ids stay opaque. */
  currentUserLabel?: string;
  /** Server-derived capability hint. Every mutation is still reauthorized. */
  canArchive?: boolean;
  reportHref?: (id: string) => string;
  authorLabel?: (userId: string) => string | undefined;
}
let {
  client,
  serverAvailable = true,
  currentUserId,
  clientScope,
  currentUserLabel,
  canArchive = false,
  reportHref,
  authorLabel,
}: Props = $props();
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
const resolveAuthor = (userId: string): string | undefined =>
  authorLabel?.(userId) ??
  (userId === currentUserId ? currentUserLabel : undefined);
</script>

{#if serverAvailable && !browserClient}
  <p role="status">{t(M['reports.loading'])}</p>
{:else}
  <SavedReports
    client={serverAvailable ? browserClient : undefined}
    {reportHref}
    authorLabel={resolveAuthor}
  />
{/if}
