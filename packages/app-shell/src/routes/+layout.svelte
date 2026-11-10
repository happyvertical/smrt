<script lang="ts">
import { AppShell } from '@happyvertical/smrt-svelte/app';
import type { ShellNavItem } from '@happyvertical/smrt-svelte/workspace';
import { onMount, untrack } from 'svelte';
import { page } from '$app/state';
import '$lib/ui/ui.css';
import AssistantPanel from '$lib/assistant/AssistantPanel.svelte';
import DraftBar from '$lib/components/DraftBar.svelte';
import {
  ASSISTANT_OPEN_EVENT,
  assistantOpenKey,
  isFramed,
  planLayout,
  readAssistantOpen,
  shellStorageKey,
  writeAssistantOpen,
} from '$lib/ui/layout';
import { LiveUpdates } from '$lib/ui/live.svelte';
import { buildMenu, userMenuItems } from '$lib/ui/menu';
import { signOut } from '$lib/ui/sign-out';
import type { LayoutProps } from './$types';

let { data, children }: LayoutProps = $props();

const live = new LiveUpdates();
const isOwner = $derived(data.description !== null);

// The side menu is the person's app only; Approvals and History live in the
// user menu.
const nav: ShellNavItem[] = $derived(
  isOwner
    ? buildMenu(data.description).map((item) => ({
        id: item.id,
        href: item.href,
        label: item.label,
        icon: item.icon,
        description: item.description,
        badge:
          data.description?.mode === 'draft' &&
          item.id.startsWith('model:') &&
          !Object.hasOwn(data.liveDescription?.models ?? {}, item.id.slice(6))
            ? 'new'
            : null,
      }))
    : [],
);
const accountItems = $derived(
  isOwner ? userMenuItems(data.description?.pendingApprovals ?? 0) : [],
);

// Voice mode is not available yet: nothing in the repository connects speech
// in or out to the assistant, so the toggle says so instead of looking active.
// A plugin view has no chat of its own: sidebar and content only. The server
// says so for the first document load; a framed page says so itself. Once
// known it stays (a later data refresh does not carry the request header).
let plugin = $state(false);
$effect(() => {
  if (data.embedded) plugin = true;
});
const plan = $derived(planLayout({ owner: isOwner, plugin }));

// The chat column's open/closed choice, kept per owner on this device.
const openKey = $derived(assistantOpenKey(data.session.user?.id));
let panelOpen = $state(true);
let remembered = $state(false);
$effect(() => {
  const key = openKey;
  untrack(() => {
    panelOpen = readAssistantOpen(localStorage, key);
    remembered = true;
  });
});
$effect(() => {
  const open = panelOpen;
  if (remembered)
    writeAssistantOpen(
      localStorage,
      untrack(() => openKey),
      open,
    );
});

// Live updates only make sense for the signed-in owner.
$effect(() => {
  if (isOwner) live.start(data.description?.mode ?? 'live');
  else live.stop();
});
onMount(() => {
  if (isFramed(window)) plugin = true;
  // The welcome steps ask for the chat to be open once they finish.
  const open = () => {
    panelOpen = true;
  };
  window.addEventListener(ASSISTANT_OPEN_EVENT, open);
  return () => {
    window.removeEventListener(ASSISTANT_OPEN_EVENT, open);
    live.stop();
  };
});
</script>

<AppShell
  storageKey={shellStorageKey(data.session.user?.id)}
  title={data.description?.name ?? 'My app'}
  {nav}
  currentHref={page.url.pathname}
  runtimeDiagnostics={isOwner}
  user={data.session.user}
  onSignOut={signOut}
  settingsHref={isOwner ? '/settings' : undefined}
  accountMenu={{ items: accountItems, theme: true }}
  colorSchemeToggle={false}
  edgeToggles={{ left: true }}
  config={{ left: { initial: 'expanded' } }}
  sidebarFooterDivider={false}
  phoneTabBar
  chrome={!page.route.id?.startsWith('/setup')}
  panelEnabled={plan.chat}
  panelLabel="Assistant"
  panelToggle={plan.chat ? { label: 'Assistant' } : false}
  voiceToggle={plan.voice
    ? {
        label: 'Voice mode',
        state: 'unavailable',
        unavailableLabel: 'Voice mode is not available yet',
      }
    : false}
  bind:panelOpen
>
  {#snippet panel({ open })}
    <AssistantPanel {open} buildingInDraft={!!data.description?.draft} />
  {/snippet}
  {#if data.description}<DraftBar description={data.description} />{/if}
  {#key data.description?.mode}
    {@render children()}
  {/key}
  <!-- Screen readers hear changes made elsewhere (the assistant, another tab). -->
  <div class="sr-only" aria-live="polite" role="status">{live.announcement}</div>
  {#if isOwner && live.status === 'reconnecting'}
    <p class="live-note" role="status">Reconnecting to your app…</p>
  {/if}
</AppShell>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  :global(.smrt-admin-shell nav.smrt-tenant-nav a[href] small) { color: var(--smrt-color-warning); }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .live-note {
    position: fixed;
    inset-block-end: var(--smrt-spacing-md, 0.75rem);
    inset-inline-start: 50%;
    transform: translateX(-50%);
    margin: 0;
    padding: var(--smrt-spacing-xs, 0.25rem) var(--smrt-spacing-md, 0.75rem);
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-inverse-surface);
    color: var(--smrt-color-inverse-on-surface);
    font-size: 0.8125rem;
    z-index: var(--smrt-z-index-toast);
  }
}
</style>
