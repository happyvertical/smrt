<script lang="ts">
  import {
    createOverview,
    OverviewGrid,
    type OverviewController,
  } from '@happyvertical/smrt-svelte/overview';
  import {
    createWidgetRegistry,
    registerRecipeWidgets,
    resolveWidgetComponents,
    resolveWidgetOptionsEditors,
    type WidgetComponents,
    type WidgetOptionsEditors,
  } from '@happyvertical/smrt-svelte/overview/server';
  import { onMount } from 'svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let controller = $state<OverviewController>();
  let components = $state<WidgetComponents>();
  let optionEditors = $state<WidgetOptionsEditors>();

  onMount(async () => {
    const registry = createWidgetRegistry();
    await registerRecipeWidgets(
      registry,
      [{ id: 'reports.runtime', surfaces: data.surfaces }],
      async (specifier, name) => {
        if (specifier !== '@happyvertical/smrt-reports/svelte') return undefined;
        const module = await import('@happyvertical/smrt-reports/svelte');
        return module[name as keyof typeof module];
      },
    );
    components = await resolveWidgetComponents(
      ['runtime-report-chart'],
      registry,
    );
    optionEditors = await resolveWidgetOptionsEditors(
      ['runtime-report-chart'],
      registry,
    );
    controller = createOverview({
      definition: data.definition,
      registry,
      loaded: data.overview,
    });
  });
</script>

<svelte:head><title>Report overview</title></svelte:head>
<main>
  <h1>Report overview</h1>
  {#if controller}
    <OverviewGrid {controller} {components} {optionEditors} editing />
  {/if}
</main>
