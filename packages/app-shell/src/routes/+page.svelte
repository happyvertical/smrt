<script lang="ts">
import { modelHref } from '$lib/ui/menu';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const description = $derived(data.description);
const models = $derived(Object.entries(description?.models ?? {}));
const who = $derived(
  data.session.user?.name || data.session.user?.email || 'there',
);
</script>

<svelte:head><title>{description?.name ?? 'My app'}</title></svelte:head>

<div class="sh-page" data-smrt-component="AppShellHome">
  {#if !data.session.authenticated}
    <header class="sh-head" data-smrt-part="header"><h1>My app</h1></header>
    <div class="sh-card" data-smrt-part="panel">
      <p><strong>You are signed out.</strong></p>
      <p class="sh-muted" data-smrt-part="description">
        Open this app from your desktop app to sign in. On a first run,
        <a class="sh-link" href="/setup" data-smrt-part="link">set up the owner</a> from this computer.
      </p>
    </div>
  {:else if !description}
    <header class="sh-head" data-smrt-part="header"><h1>My app</h1></header>
    <p class="sh-alert sh-alert-warn" role="status" data-smrt-part="status">
      Only the owner of this app can see its data.
    </p>
  {:else}
    <header class="sh-head" data-smrt-part="header">
      <div>
        <h1>{description.name}</h1>
        <p class="sh-sub" data-smrt-part="description">Hello, {who}.</p>
      </div>
      {#if description.pendingApprovals > 0}
        <a class="sh-btn sh-btn-primary" href="/approvals" data-smrt-part="trigger">
          {description.pendingApprovals}
          {description.pendingApprovals === 1 ? 'change waits' : 'changes wait'} for you
        </a>
      {/if}
    </header>

    {#if models.length === 0}
      <div class="sh-empty" data-smrt-part="empty">
        <p><strong>Your app is empty</strong></p>
        <p class="sh-muted" data-smrt-part="description">
          Ask the assistant to build something, for example “track my chores
          with a due date and who does them”. Your menu and forms appear here as
          it builds.
        </p>
      </div>
    {:else}
      <h2 class="smrt-app-shell-home__sr-only" data-smrt-part="label">Your data</h2>
      <ul class="sh-tiles" data-smrt-part="list">
        {#each models as [name, model] (name)}
          {@const c = data.counts[name]}
          <li>
            <a class="sh-tile" href={modelHref(name)} data-smrt-part="link">
              <strong>{c ? `${c.count}${c.capped ? '+' : ''}` : '–'}</strong>
              <span>{model.label || name}</span>
              <span class="sh-muted" data-smrt-part="description">
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
  .sh-tile span {
    display: block;
  }
}

@layer smrt.theme {
}
</style>
