<script lang="ts">
import { AppShell } from '@happyvertical/smrt-svelte/app';
import type { ShellNavItem } from '@happyvertical/smrt-svelte/workspace';
import { ToastViewport, toaster } from '@happyvertical/smrt-ui';
import { onMount, untrack } from 'svelte';
import { goto, invalidateAll } from '$app/navigation';
import { page } from '$app/state';
import '$lib/ui/ui.css';
import AssistantPanel from '$lib/assistant/AssistantPanel.svelte';
import ChangesPill from '$lib/components/ChangesPill.svelte';
import { ApiError, isLimitRefusal } from '$lib/ui/api';
import { changesApi } from '$lib/ui/changes';
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

/**
 * The chat reply block's Apply: the owner's own click, on the same digest-pinned
 * route as the Changes waiting page. `applyNow` only says which button was
 * shown; the server decides eligibility itself and refuses (review first) when
 * the batch is not a small, additive, assistant-made change.
 */
async function applyFromChat(applyNow: boolean): Promise<void> {
  const changes = data.changes;
  if (!changes) return;
  try {
    await changesApi.apply(
      changes.digest,
      { generation: changes.generation },
      applyNow ? 'chat' : undefined,
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 409)
      throw new Error(
        isLimitRefusal(e) ||
          e.message.startsWith("Can't apply yet") ||
          e.message.startsWith('This one needs')
          ? e.message
          : 'These changes were different when you last looked. Review them, then Apply.',
      );
    throw e;
  }
  toaster.success('Applied. Your app is live', {
    duration: 8000,
    action: { label: 'See History', run: () => goto('/history') },
  });
  await invalidateAll();
}
const isStaff = $derived(data.description?.staff === true);
const isOwner = $derived(data.description !== null && !isStaff);

// The side menu is the person's app only; Approvals and History live in the
// user menu.
const nav: ShellNavItem[] = $derived(
  data.description && (isOwner || isStaff)
    ? buildMenu(data.description).map((item) => ({
        id: item.id,
        href: item.href,
        label: item.label,
        icon: item.icon,
        description: item.description,
        children: item.children,
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
const onboarding = $derived(
  !data.onboardingComplete || page.url.pathname === '/welcome',
);
const plan = $derived(planLayout({ owner: isOwner && !onboarding, plugin }));
// The chat column's open/closed choice, kept per owner on this device.
const openKey = $derived(assistantOpenKey(data.session.user?.id));
let panelOpen = $state(false);
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
  if (isOwner || isStaff) live.start();
  else live.stop();
});
// Toasts sit in the bottom corner of the page's own content region, so the
// docked chat column (composer and Send) is never under one. Without the
// region (setup, plugin frames without chrome) they fall back to the window.
let toastAnchor = $state<HTMLElement | null>(null);
$effect(() => {
  void page.url.pathname;
  void panelOpen;
  void plugin;
  toastAnchor = document.getElementById('smrt-admin-shell-main');
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

{#snippet headerEnd()}
  {#if isOwner && !plugin && !onboarding}<ChangesPill changes={data.changes} current={page.url.pathname === '/changes'} />{/if}
{/snippet}

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
  config={{ left: { initial: 'collapsed' } }}
  sidebarFooterDivider={false}
  phoneTabBar
  chrome={!page.route.id?.startsWith('/setup')}
  panelEnabled={plan.chat}
  panelLabel="Assistant"
  panelSide="end"
  panelSize={400}
  panelToggle={plan.chat ? { label: 'Assistant' } : false}
  voiceToggle={plan.voice
    ? {
        label: 'Voice mode',
        state: 'unavailable',
        unavailableLabel: 'Voice mode is not available yet',
      }
    : false}
  slots={{ 'header.end': headerEnd }}
  bind:panelOpen
>
  {#snippet panel({ open })}
    <AssistantPanel {open} owner={data.session.user} changes={data.changes} definition={data.description ?? undefined} onapply={applyFromChat} />
  {/snippet}
  {@render children()}
  <!-- Screen readers hear changes made elsewhere (the assistant, another tab). -->
  <div class="smrt-app-shell-layout__sr-only" aria-live="polite" role="status" data-smrt-part="label">{live.announcement}</div>
  {#if (isOwner || isStaff) && live.status === 'reconnecting'}
    <p class="smrt-app-shell-layout__live-note" role="status" data-smrt-part="status">Reconnecting to your app…</p>
  {/if}
</AppShell>
<ToastViewport anchor={toastAnchor} />

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
    margin: 0;
    padding: var(--smrt-spacing-xs, 0.25rem) var(--smrt-spacing-md, 0.75rem);
    z-index: var(--smrt-z-index-toast);
  }
}

@layer smrt.structure {
  .smrt-app-shell-layout__live-note {
    transform: translateX(-50%);
  }
}

@layer smrt.theme {
  :global(.smrt-admin-shell nav.smrt-tenant-nav a[href] small) {
    color: var(--smrt-color-warning);
  }
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
