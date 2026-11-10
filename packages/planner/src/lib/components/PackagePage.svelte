<script lang="ts">
// One package: its models, dependencies and the tools that connect to it.
// The static app's `/packages/[id]/` route and the mounted `Planner`'s
// `#/packages/<id>/` both render this, so a feature's package link resolves
// in either.
import { exposedModels, getPackage } from '../catalog/index.ts';
import { humanize } from '../data/format.ts';
import { appHref } from '../planner/app.svelte.ts';
import ConnectTools from './ConnectTools.svelte';

interface PackagePageProps {
  /** The catalog package id (`commerce`). */
  id: string;
  /** Where "Unknown package" leads back to. */
  backHref?: string;
}

let { id, backHref }: PackagePageProps = $props();

const pkg = $derived(getPackage(id));
</script>

{#if pkg}
  <main data-smrt-component="PackagePage">
    <header>
      <h1>{humanize(pkg.id)}</h1>
      <p class="smrt-package-page__meta" data-smrt-part="meta"><code>{pkg.packageName}@{pkg.version}</code></p>
      <p>{pkg.description}</p>
      {#if pkg.dependencies.length}
        <p class="smrt-package-page__meta" data-smrt-part="meta">
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
            <span class="smrt-package-page__meta" data-smrt-part="meta">{model.fields.filter((f) => !f.system).length} fields</span>
          </li>
        {/each}
      </ul>
    </section>

    <ConnectTools models={pkg.models} />
  </main>
{:else}
  <main data-smrt-component="PackagePage">
    <h1>Unknown package</h1>
    <p>No package is called <code>{id}</code>.{#if backHref} <a href={backHref}>Back to the Planner</a>{/if}</p>
  </main>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
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
  ul {
    display: grid;
    gap: var(--smrt-spacing-1);
    margin: 0;
    padding-left: var(--smrt-spacing-5);
  }
}

@layer smrt.theme {
  .smrt-package-page__meta {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
