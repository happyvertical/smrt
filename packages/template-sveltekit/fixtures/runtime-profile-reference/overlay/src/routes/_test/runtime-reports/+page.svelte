<script lang="ts">
  import {
    AssistantDock,
    type AssistantTransport,
  } from '@happyvertical/smrt-chat/svelte';
  import { runtimeReportToolResultComponent } from '@happyvertical/smrt-reports/svelte';
  import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const thread = {
    id: 'runtime-report-proposal',
    title: 'Report assistant',
    isResolved: false,
    messageCount: 1,
    lastMessageAt: new Date(),
  };
  const transport: AssistantTransport = {
    listThreads: async () => [thread],
    loadMessages: async () => [
      {
        id: 'proposal',
        threadId: thread.id,
        role: 'tool',
        content: 'Review the proposed report.',
        createdAt: new Date(),
        toolCallData: {
          name: 'reports.runtime.define',
          result: data.proposal,
        },
      },
    ],
    sendMessage: async () => ({ inProgress: false }),
  };
</script>

<svelte:head><title>Runtime report confirmation</title></svelte:head>
<main>
  <h1>Assistant report proposal</h1>
  <AssistantDock
    {transport}
    registry={createDataSurfaceRegistry()}
    contextMode="server"
    conversations="single"
    threadList={false}
    toolResultComponent={runtimeReportToolResultComponent}
  />
</main>
