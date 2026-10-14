<script lang="ts">
import { onMount } from 'svelte';
import { getRuntimeReportsBrowserClient } from './browser-client.js';
import ReportConfirmation from './ReportConfirmation.svelte';
import {
  runtimeReportProposalFromMessage,
  type ToolResultMessage,
} from './tool-result.js';
import type { RuntimeReportsClient } from './types.js';

export interface Props {
  message: ToolResultMessage;
}
let { message }: Props = $props();
const proposal = $derived(runtimeReportProposalFromMessage(message));
let client = $state<RuntimeReportsClient | undefined>();
onMount(() => {
  client = getRuntimeReportsBrowserClient();
});
</script>

{#if proposal && client}
  <ReportConfirmation {proposal} confirm={client.confirm} />
{/if}
