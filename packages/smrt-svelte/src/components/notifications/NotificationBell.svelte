<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n/strings.notifications.js';
import type { NotificationProvider } from './types.js';

interface Props {
  /** Authorized provider that supplies this user's notification state. */
  provider: NotificationProvider;
  /** Accessible trigger and panel heading. */
  label?: string;
  /** Maximum number of recent notifications requested from the provider. */
  limit?: number;
}
const { t } = useI18n();
let { provider, label, limit = 20 }: Props = $props();
const heading = $derived(label ?? t(M['ui.notification_bell.label']));
const instanceId = $props.id();
let panel = $state<HTMLDivElement>();
let open = $state(false);
$effect(() => {
  if (open) panel?.focus();
});
let loading = $state(true);
let error = $state<string | null>(null);
let unread = $state(0);
let items = $state<Awaited<ReturnType<NotificationProvider['list']>>>([]);
let request = 0;
let generation = 0;
let active = false;

async function refresh(source = provider, epoch = generation) {
  if (!active || epoch !== generation) return;
  const current = ++request;
  loading = true;
  error = null;
  try {
    const [nextUnread, nextItems] = await Promise.all([
      source.getUnreadCount(),
      source.list({ limit }),
    ]);
    if (!active || epoch !== generation || current !== request) return;
    unread =
      Number.isSafeInteger(nextUnread) && nextUnread > 0 ? nextUnread : 0;
    items = nextItems;
  } catch {
    if (!active || epoch !== generation || current !== request) return;
    error = M['ui.notification_bell.unavailable'];
  } finally {
    if (active && epoch === generation && current === request) loading = false;
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
  document.getElementById(`${instanceId}-trigger`)?.focus();
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open) {
    event.preventDefault();
    close();
  }
}
async function mutate(id?: string) {
  const source = provider;
  const epoch = generation;
  try {
    if (id) await source.markRead(id);
    else await source.markAllRead();
    await refresh(source, epoch);
  } catch {
    if (active && epoch === generation)
      error = M['ui.notification_bell.mark_error'];
  }
}
$effect(() => {
  const source = provider;
  const epoch = ++generation;
  active = true;
  items = [];
  unread = 0;
  error = null;
  void refresh(source, epoch);
  let stop: (() => void) | undefined;
  try {
    stop = source.subscribe?.(() => void refresh(source, epoch));
  } catch {
    error = M['ui.notification_bell.live_error'];
  }
  return () => {
    active = false;
    ++generation;
    ++request;
    stop?.();
  };
});
</script>

<div class="smrt-notification-bell">
  <Button id={`${instanceId}-trigger`} aria-controls={`${instanceId}-panel`} variant="ghost" aria-haspopup="dialog" aria-expanded={open} onclick={() => (open = !open)}>
    {heading}{#if unread > 0}<span aria-label={t(M['ui.notification_bell.unread'], { count: unread })}> ({unread})</span>{/if}
  </Button>
  {#if open}
    <div bind:this={panel} id={`${instanceId}-panel`} role="dialog" aria-label={heading} tabindex="-1" onkeydown={keydown} class="smrt-notification-bell__panel">
      <header><strong>{heading}</strong><Button variant="ghost" size="sm" disabled={unread === 0 || loading} onclick={() => mutate()}>{t(M['ui.notification_bell.mark_all'])}</Button></header>
      {#if error}<p role="alert">{t(error)}</p>{/if}
      {#if loading}<p role="status">{t(M['ui.notification_bell.loading'])}</p>{:else if items.length === 0}<p>{t(M['ui.notification_bell.empty'])}</p>{:else}<ol>
        {#each items as item (item.id)}<li data-read={item.readAt ? 'true' : 'false'}>
          {#if safeHref(item.href)}<a href={safeHref(item.href) ?? undefined}>{item.title}</a>{:else}<strong>{item.title}</strong>{/if}
          {#if item.body}<p>{item.body}</p>{/if}
          {#if !item.readAt}<Button variant="ghost" size="sm" onclick={() => mutate(item.id)}>{t(M['ui.notification_bell.mark_one'])}</Button>{/if}
        </li>{/each}
      </ol>{/if}
    </div>
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
