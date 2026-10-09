<script lang="ts">
import { exposedModels, getPackage } from '$lib/catalog/index.ts';
import ConnectTools from '$lib/components/ConnectTools.svelte';
import { humanize } from '$lib/data/format.ts';
import { appHref } from '$lib/planner/app.svelte.ts';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const pkg = $derived(getPackage(data.id));
</script>

<svelte:head>
  <title>{humanize(data.id)} · smrt planner</title>
</svelte:head>

{#if pkg}
  <main>
    <header>
      <h1>{humanize(pkg.id)}</h1>
      <p class="meta"><code>{pkg.packageName}@{pkg.version}</code></p>
      <p>{pkg.description}</p>
      {#if pkg.dependencies.length}
        <p class="meta">
          Needs:
          {#each pkg.dependencies as dependency, i (dependency)}
            {#if i > 0},
            {/if}<a href={appHref(`/packages/${dependency}/`)}>{humanize(dependency)}</a>
          {/each}
        </p>
      {/if}
    </header>

    <section>
      <h2>Models</h2>
      <ul>
        {#each exposedModels(pkg) as model (model.id)}
          <li>
            <a href={appHref(`/m/${pkg.id}/${model.name}/`)}>{model.name}</a>
            <span class="meta">{model.fields.filter((f) => !f.system).length} fields</span>
          </li>
        {/each}
      </ul>
    </section>

    <ConnectTools models={pkg.models} />
  </main>
{/if}

<style>
  main {
    display: grid;
    gap: var(--smrt-spacing-6);
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  header,
  section {
    display: grid;
    gap: var(--smrt-spacing-2);
    justify-items: start;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  .meta {
    color: var(--smrt-color-on-surface-variant);
  }

  ul {
    display: grid;
    gap: var(--smrt-spacing-1);
    margin: 0;
    padding-left: var(--smrt-spacing-5);
  }

</style>
