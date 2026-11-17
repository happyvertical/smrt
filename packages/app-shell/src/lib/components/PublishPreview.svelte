<script lang="ts">
import { Badge, Stack } from '@happyvertical/smrt-ui';
import type { Snippet } from 'svelte';
import {
  publishCalculations,
  publishChanges,
  publishDataTables,
  publishMethodLabel,
  publishOtherDataLines,
  publishQuietLine,
  publishSummaryGroups,
} from '$lib/ui/publish';
import type { PublishPreview } from '$lib/ui/types';
import PublishDataTable from './PublishDataTable.svelte';

let { preview, actions }: { preview: PublishPreview; actions?: Snippet } =
  $props();
const tables = $derived(publishDataTables(preview));
const otherData = $derived(publishOtherDataLines(preview));
const groups = $derived(publishSummaryGroups(preview));
const quiet = $derived(publishQuietLine(preview));
const changes = $derived(publishChanges(preview));
const calculations = $derived(publishCalculations(preview));
</script>

<Stack gap="lg">
<section class="smrt-publish-preview__summary" aria-label="Summary">
  <h2>What will be published</h2>
  {#if tables.length || otherData.length}
    <section aria-label="Data">
      <h3 class="smrt-publish-preview__heading">Data <Badge variant="neutral">{tables.length + otherData.length}</Badge></h3>
      {#each tables as table (table.model)}<PublishDataTable {table} />{/each}
      {#if otherData.length}<ul>{#each otherData as line (line)}<li>{line}</li>{/each}</ul>{/if}
      <p class="smrt-app-shell__muted">Replayed against current live records. Records you add by hand in the draft are not published.</p>
    </section>
  {/if}
  {#each groups as group (group.name)}
    <section aria-label={group.name}>
      <h3 class="smrt-publish-preview__heading">{group.name} <Badge variant="neutral">{group.count}</Badge></h3>
      <ul>{#each group.items as item (item)}<li>{item}</li>{/each}</ul>
      {#if group.note}<p class="smrt-app-shell__muted">{group.note}</p>{/if}
    </section>
  {/each}
  {#if quiet}<p class="smrt-app-shell__muted">{quiet}</p>{/if}
</section>
{#if actions}{@render actions()}{/if}
{#if changes.length}
<details>
  <summary>Changes in order ({changes.length})</summary>
  <ol>
    {#each changes as change (change.version)}<li><p>{change.text}</p></li>{/each}
  </ol>
</details>
{/if}
{#if calculations.length}
<h2>Calculated field changes</h2>
<ul>{#each calculations as line (line)}<li>{line}</li>{/each}</ul>
{/if}
{#if preview.methods.length}
<details>
  <summary>All method code ({preview.methods.length})</summary>
  {#each preview.methods as method (method.model + '.' + method.name)}
    <section aria-label={publishMethodLabel(method, preview)}>
      <h3>{publishMethodLabel(method, preview)} · {method.change}</h3>
      <p>{method.description}</p>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling of full method code) -->
      <pre class="smrt-app-shell__code" tabindex="0" aria-label="Code for {publishMethodLabel(method, preview)}"><code>{method.code}</code></pre>
    </section>
  {/each}
</details>
{/if}
</Stack>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-publish-preview__summary {
    min-width: 0;
    overflow-wrap: normal;
    word-break: normal;
  }
  .smrt-publish-preview__heading {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-sm);
    white-space: nowrap;
  }
}
</style>
