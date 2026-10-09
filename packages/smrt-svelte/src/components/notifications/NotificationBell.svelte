<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type { NotificationProvider } from './types.js';

interface Props {
  /** Authorized provider that supplies this user's notification state. */
  provider: NotificationProvider;
  /** Accessible trigger and panel heading. */
  label?: string;
  /** Maximum number of recent notifications requested from the provider. */
  limit?: number;
}
let { provider, label = 'Notifications', limit = 20 }: Props = $props();
let open = $state(false);
let loading = $state(true);
let error = $state<string | null>(null);
let unread = $state(0);
let items = $state<Awaited<ReturnType<NotificationProvider['list']>>>([]);
let request = 0;

async function refresh() {
  const current = ++request;
  loading = true;
  error = null;
  try {
    const [nextUnread, nextItems] = await Promise.all([
      provider.getUnreadCount(),
      provider.list({ limit }),
    ]);
    if (current !== request) return;
    unread =
      Number.isSafeInteger(nextUnread) && nextUnread > 0 ? nextUnread : 0;
    items = nextItems;
  } catch {
    if (current !== request) return;
    error = 'Notifications are unavailable.';
  } finally {
    loading = false;
  }
}
function safeHref(value: string | null | undefined): string | null {
  if (!value || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const parsed = new URL(value, 'https://smrt.invalid');
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? value
      : null;
  } catch {
    return null;
  }
}
function close() {
  open = false;
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open) {
    event.preventDefault();
    close();
  }
}
async function markRead(id: string) {
  try {
    await provider.markRead(id);
    await refresh();
  } catch {
    error = 'Could not mark this notification read.';
  }
}
async function markAllRead() {
  try {
    await provider.markAllRead();
    await refresh();
  } catch {
    error = 'Could not mark notifications read.';
  }
}
$effect(() => {
  provider;
  void refresh();
  return provider.subscribe?.(() => void refresh());
});
</script>

<div class="smrt-notification-bell">
  <Button variant="ghost" aria-haspopup="dialog" aria-expanded={open} onclick={() => (open = !open)}>
    {label}{#if unread > 0}<span aria-label={`${unread} unread`}> ({unread})</span>{/if}
  </Button>
  {#if open}
    <section role="dialog" aria-label={label} tabindex="-1" onkeydown={keydown} class="smrt-notification-bell__panel">
      <header><strong>{label}</strong><Button variant="ghost" size="sm" disabled={unread === 0 || loading} onclick={markAllRead}>Mark all read</Button></header>
      {#if error}<p role="alert">{error}</p>{/if}
      {#if loading}<p role="status">Loading notifications</p>{:else if items.length === 0}<p>No notifications.</p>{:else}<ol>
        {#each items as item (item.id)}<li data-read={item.readAt ? 'true' : 'false'}>
          {#if safeHref(item.href)}<a href={safeHref(item.href) ?? undefined}>{item.title}</a>{:else}<strong>{item.title}</strong>{/if}
          {#if item.body}<p>{item.body}</p>{/if}
          {#if !item.readAt}<Button variant="ghost" size="sm" onclick={() => markRead(item.id)}>Mark read</Button>{/if}
        </li>{/each}
      </ol>{/if}
    </section>
  {/if}
</div>

<style>
  .smrt-notification-bell { position: relative; }
  .smrt-notification-bell__panel { position: absolute; z-index: 1; inset-block-start: 100%; inset-inline-end: 0; inline-size: min(24rem, 90vw); padding: var(--smrt-spacing-3); background: var(--smrt-color-surface); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-medium); }
  header { display: flex; justify-content: space-between; gap: var(--smrt-spacing-2); }
  ol { display: grid; gap: var(--smrt-spacing-2); padding: 0; list-style: none; }
  li { padding-block: var(--smrt-spacing-2); border-block-end: 1px solid var(--smrt-color-outline-variant); }
  li[data-read='false'] { border-inline-start: 3px solid var(--smrt-color-primary); padding-inline-start: var(--smrt-spacing-2); }
  p { overflow-wrap: anywhere; }
</style>
