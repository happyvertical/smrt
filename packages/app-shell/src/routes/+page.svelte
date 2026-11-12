<script lang="ts">
import { greeting } from '$lib/ui/greeting';
import { modelHref } from '$lib/ui/menu';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const description = $derived(data.description);
const models = $derived(Object.entries(description?.models ?? {}));
const hello = $derived(greeting(data.session.user));
</script>

<svelte:head><title>{description?.name ?? 'My app'}</title></svelte:head>

<div class="smrt-app-shell__page" data-smrt-component="AppShellHome">
  {#if !data.session.authenticated}
    <header class="smrt-app-shell__head" data-smrt-part="header"><h1>My app</h1></header>
    <div class="smrt-app-shell__card" data-smrt-part="panel">
      <p><strong>You are signed out.</strong></p>
      {#if data.desktop}
        <p class="smrt-app-shell__muted">
          Quit and reopen the app to sign back in.
        </p>
      {:else}
        <p class="smrt-app-shell__muted">
          Open this app from your desktop app to sign in. On a first run,
          <a class="smrt-app-shell__link" href="/setup">set up the owner</a> from this computer.
        </p>
      {/if}
    </div>
  {:else if !description}
    <header class="smrt-app-shell__head" data-smrt-part="header"><h1>My app</h1></header>
    <p class="smrt-app-shell__alert smrt-app-shell__alert-warn" role="status" data-smrt-part="status">
      Only the owner of this app can see its data.
    </p>
  {:else}
    <header class="smrt-app-shell__head" data-smrt-part="header">
      <div>
        <h1>{description.name}</h1>
        <p class="smrt-app-shell__sub">{hello}</p>
      </div>
      {#if description.pendingApprovals > 0}
        <a class="smrt-app-shell__btn smrt-app-shell__btn-primary" href="/approvals" data-smrt-part="trigger">
          {description.pendingApprovals}
          {description.pendingApprovals === 1 ? 'change waits' : 'changes wait'} for you
        </a>
      {/if}
    </header>

    {#if models.length === 0}
      <div class="smrt-app-shell__empty" data-smrt-part="empty">
        <p><strong>Your app is empty</strong></p>
        <p class="smrt-app-shell__muted" data-smrt-part="description">
          Ask the assistant to build something, for example “track my chores
          with a due date and who does them”. Your menu and forms appear here as
          it builds.
        </p>
      </div>
    {:else}
      <h2 class="smrt-app-shell-home__sr-only" data-smrt-part="label">Your data</h2>
      <ul class="smrt-app-shell__tiles" data-smrt-part="list">
        {#each models as [name, model] (name)}
          {@const c = data.counts[name]}
          <li>
            <a class="smrt-app-shell__tile" href={modelHref(name)} data-smrt-part="link">
              <strong>{c ? `${c.count}${c.capped ? '+' : ''}` : '–'}</strong>
              <span>{model.label || name}</span>
              <span class="smrt-app-shell__muted" data-smrt-part="description">
                {c?.count === 1 ? 'record' : 'records'}
              </span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-app-shell-home__sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .smrt-app-shell__tile span {
    display: block;
  }
}
</style>
