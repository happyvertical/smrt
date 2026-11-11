<script lang="ts">
import { Badge, Card, Grid, Stack } from '@happyvertical/smrt-ui';
import { fieldLabel } from '$lib/ui/fields';
import { formulaWords } from '$lib/ui/formula';
import { publishGroups } from '$lib/ui/publish';
import type { PublishPreview } from '$lib/ui/types';

let { preview }: { preview: PublishPreview } = $props();
const groups = $derived(publishGroups(preview));
</script>

<Stack gap="lg">
<Grid columns={{ sm: 1, md: 2 }} gap="md">
  {#each groups as group (group.name)}
    <section aria-label={group.name}>
      <Card padding="sm">
        <Stack gap="sm">
          <Stack direction="horizontal" align="center" gap="sm">
            <h2>{group.name}</h2><Badge variant="neutral">{group.count}</Badge>
          </Stack>
          {#if group.items.length}
            <ul>{#each group.items as item (item)}<li>{item}</li>{/each}</ul>
          {:else}<p class="sh-muted">None.</p>{/if}
          {#if group.note}<p class="sh-muted">{group.note}</p>{/if}
        </Stack>
      </Card>
    </section>
  {/each}
</Grid>
<p>Counts can change until you publish as live records change. Records added in the draft are thrown away.</p>
<h2>Changes to publish ({preview.versions.length})</h2>
<ol>
  {#each preview.versions as version (version.version)}
    <li>
      <p>{version.summary}</p>
    </li>
  {/each}
</ol>
{#if Object.values(preview.fields ?? {}).some(fields => Object.values(fields).some(field => field.calculated))}
<h2>Calculated fields</h2>
<ul>{#each Object.entries(preview.fields ?? {}) as [model, fields] (model)}{#each Object.entries(fields) as [name, field] (name)}{#if field.calculated}<li>{model} · {fieldLabel(name, field)}: {formulaWords(field.calculated, fields)}</li>{/if}{/each}{/each}</ul>
{/if}
<h2>All method code ({preview.methods.length})</h2>
{#each preview.methods as method (method.model + '.' + method.name)}
  <section aria-label="{method.model}.{method.name}">
    <h3>{method.model}.{method.name}() · {method.change}</h3>
    <p>{method.description}</p>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling of full method code) -->
    <pre class="sh-code" tabindex="0" aria-label="Code for {method.model}.{method.name}"><code>{method.code}</code></pre>
  </section>
{/each}

</Stack>
