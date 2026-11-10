<script lang="ts">
import { publishLines } from '$lib/ui/publish';
import type { PublishPreview } from '$lib/ui/types';

let { preview }: { preview: PublishPreview } = $props();
const lines = $derived(publishLines(preview));
</script>

<ul>
  {#each lines as line, i (i)}<li>{line}</li>{/each}
</ul>
<p>Counts can change until you publish as live records change. Records added in the draft are thrown away.</p>
<h2>Changes to publish ({preview.versions.length})</h2>
<ol>
  {#each preview.versions as version (version.version)}
    <li>
      <p>{version.summary}</p>
    </li>
  {/each}
</ol>
<h2>All method code ({preview.methods.length})</h2>
{#each preview.methods as method (method.model + '.' + method.name)}
  <section aria-label="{method.model}.{method.name}">
    <h3>{method.model}.{method.name}() · {method.change}</h3>
    <p>{method.description}</p>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling of full method code) -->
    <pre class="sh-code" tabindex="0" aria-label="Code for {method.model}.{method.name}"><code>{method.code}</code></pre>
  </section>
{/each}
