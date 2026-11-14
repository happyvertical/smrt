<script lang="ts">
import { Badge, Card, Stack } from '@happyvertical/smrt-ui';
import {
  publishCalculations,
  publishGroups,
  publishMethodLabel,
  publishVersionSummary,
} from '$lib/ui/publish';
import type { PublishPreview } from '$lib/ui/types';

let { preview }: { preview: PublishPreview } = $props();
const groups = $derived(publishGroups(preview));
const calculations = $derived(publishCalculations(preview));
</script>

<Stack gap="lg">
<div class="smrt-publish-preview__groups">
  {#each groups as group (group.name)}
    <section class="smrt-publish-preview__group" aria-label={group.name}>
      <Card padding="sm">
        <Stack gap="sm">
          <div class="smrt-publish-preview__group-heading">
            <h2>{group.name}</h2><Badge variant="neutral">{group.count}</Badge>
          </div>
          {#if group.items.length}
            <ul>{#each group.items as item (item)}<li>{item}</li>{/each}</ul>
          {:else}<p class="smrt-app-shell__muted">None.</p>{/if}
          {#if group.note}<p class="smrt-app-shell__muted">{group.note}</p>{/if}
        </Stack>
      </Card>
    </section>
  {/each}
</div>
<p>Data commands replay against current live records. If reviewed counts change, review a fresh preview before publishing. Direct record edits made in the draft are discarded; records loaded by a draft command are replayed.</p>
<h2>Changes to publish ({preview.versions.length})</h2>
<ol>
  {#each preview.versions as version (version.version)}
    <li>
      <p>{publishVersionSummary(version, preview)}</p>
    </li>
  {/each}
</ol>
{#if calculations.length}
<h2>Calculated field changes</h2>
<ul>{#each calculations as line (line)}<li>{line}</li>{/each}</ul>
{/if}
<h2>All method code ({preview.methods.length})</h2>
{#each preview.methods as method (method.model + '.' + method.name)}
  <section aria-label={publishMethodLabel(method, preview)}>
    <h3>{publishMethodLabel(method, preview)} · {method.change}</h3>
    <p>{method.description}</p>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling of full method code) -->
    <pre class="smrt-app-shell__code" tabindex="0" aria-label="Code for {publishMethodLabel(method, preview)}"><code>{method.code}</code></pre>
  </section>
{/each}

</Stack>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-publish-preview__groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
    gap: var(--smrt-spacing-md);
    min-width: 0;
  }
  .smrt-publish-preview__group {
    min-width: 0;
    overflow-wrap: normal;
    word-break: normal;
  }
  .smrt-publish-preview__group-heading {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-sm);
    white-space: nowrap;
  }
  .smrt-publish-preview__group-heading h2 {
    margin: 0;
  }
}
</style>
