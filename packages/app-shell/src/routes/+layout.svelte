<script lang="ts">
import { AppShell } from '@happyvertical/smrt-svelte/app';
import type { ShellNavItem } from '@happyvertical/smrt-svelte/workspace';
import { onMount } from 'svelte';
import { page } from '$app/state';
import '$lib/ui/ui.css';
import AssistantDock from '$lib/assistant/AssistantDock.svelte';
import { LiveUpdates } from '$lib/ui/live.svelte';
import { buildMenu } from '$lib/ui/menu';
import { signOut } from '$lib/ui/sign-out';
import type { LayoutProps } from './$types';

let { data, children }: LayoutProps = $props();

const live = new LiveUpdates();
const isOwner = $derived(data.description !== null);

const nav: ShellNavItem[] = $derived(
  isOwner
    ? buildMenu(data.description, data.description?.pendingApprovals ?? 0).map(
        (item) => ({
          id: item.id,
          href: item.href,
          label: item.label,
          icon: item.icon,
          description: item.description,
          badge: item.badge ?? null,
          attention: item.attention
            ? 'Changes are waiting for your approval'
            : false,
        }),
      )
    : [],
);

// Live updates only make sense for the signed-in owner.
$effect(() => {
  if (isOwner) live.start();
  else live.stop();
});
onMount(() => () => live.stop());
</script>

<AppShell
  title={data.description?.name ?? 'My app'}
  {nav}
  currentHref={page.url.pathname}
  runtimeDiagnostics={isOwner}
  user={data.session.user}
  onSignOut={signOut}
  phoneTabBar
  chrome={!page.route.id?.startsWith('/setup')}
>
  {@render children()}
  <!-- Screen readers hear changes made elsewhere (the assistant, another tab). -->
  <div class="smrt-app-shell-layout__sr-only" aria-live="polite" role="status" data-smrt-part="label">{live.announcement}</div>
  {#if isOwner && live.status === 'reconnecting'}
    <p class="smrt-app-shell-layout__live-note" role="status" data-smrt-part="status">Reconnecting to your app…</p>
  {/if}
  {#if isOwner}
    <AssistantDock />
  {/if}
</AppShell>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-app-shell-layout__sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .smrt-app-shell-layout__live-note {
    position: fixed;
    inset-block-end: var(--smrt-spacing-md, 0.75rem);
    inset-inline-start: 50%;
    transform: translateX(-50%);
    margin: 0;
    padding: var(--smrt-spacing-xs, 0.25rem) var(--smrt-spacing-md, 0.75rem);
    z-index: 50;
  }
}

@layer smrt.theme {
  .smrt-app-shell-layout__sr-only {
    border: 0;
  }
  .smrt-app-shell-layout__live-note {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-inverse-surface);
    color: var(--smrt-color-inverse-on-surface);
    font-size: 0.8125rem;
  }
}
</style>
