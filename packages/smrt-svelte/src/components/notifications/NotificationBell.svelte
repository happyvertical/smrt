<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ComponentProps } from 'svelte';
import { M } from '../../i18n/strings.notifications.js';
import type { NotificationProvider } from './types.js';

interface Props {
  /** Authorized provider that supplies this user's notification state. */
  provider: NotificationProvider;
  /** Accessible trigger and panel heading. */
  label?: string;
  /** Maximum number of recent notifications requested from the provider. */
  limit?: number;
  /** Show a bell icon with an unread dot/count instead of the text label. */
  iconOnly?: boolean;
  /** `'below'` (default) opens under the trigger; `'beside'` opens at its inline end. */
  placement?: 'below' | 'beside';
  /** Trigger button variant. */
  variant?: ComponentProps<typeof Button>['variant'];
  /**
   * Whether the panel is open. Bindable, so a host can close it (or open it)
   * itself; the bell still toggles it from the trigger and closes it on light
   * dismiss (#4566).
   */
  open?: boolean;
  /** Called after the panel opens or closes, with the new state. */
  onopenchange?: (open: boolean) => void;
}
const { t } = useI18n();
let {
  provider,
  label,
  limit = 20,
  iconOnly = false,
  placement = 'below',
  variant = 'ghost',
  open = $bindable(false),
  onopenchange,
}: Props = $props();
const heading = $derived(label ?? t(M['ui.notification_bell.label']));
const instanceId = $props.id();
let root = $state<HTMLDivElement>();
let panel = $state<HTMLDivElement>();
$effect(() => {
  if (open) panel?.focus();
});
function setOpen(next: boolean) {
  if (open === next) return;
  open = next;
  onopenchange?.(next);
}
// Light dismiss (#4566): a pointer-down anywhere outside the bell closes the
// panel, like `Popover`. Captured on the document so a click that lands on a
// control which stops propagation still counts as "outside".
$effect(() => {
  if (!open || typeof document === 'undefined') return;
  const dismiss = (event: PointerEvent) => {
    if (event.target instanceof Node && !root?.contains(event.target))
      setOpen(false);
  };
  document.addEventListener('pointerdown', dismiss, true);
  return () => document.removeEventListener('pointerdown', dismiss, true);
});
let loading = $state(true);
let error = $state<string | null>(null);
let unread = $state(0);
const unreadText = $derived(
  t(M['ui.notification_bell.unread'], { count: unread }),
);
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
  setOpen(false);
  document.getElementById(`${instanceId}-trigger`)?.focus();
}
// Escape closes the panel wherever focus is (the body after following a
// notice, a control elsewhere in the shell), not only inside the panel. A
// dialog or palette that owns Escape already stops it before it gets here.
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open && !event.defaultPrevented) {
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

<svelte:document onkeydown={keydown} />

<div bind:this={root} class="smrt-notification-bell__root" data-placement={placement} data-smrt-component="NotificationBell">
  <Button id={`${instanceId}-trigger`} aria-controls={`${instanceId}-panel`} {variant} aria-haspopup="dialog" aria-expanded={open} aria-label={iconOnly ? (unread > 0 ? `${heading}, ${unreadText}` : heading) : undefined} onclick={() => setOpen(!open)}>
    {#if iconOnly}
      <span class="smrt-notification-bell__icon" aria-hidden="true" data-smrt-part="icon">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" focusable="false"><path d="M12 22c1.1 0 2-.9 2-2h-4a2 2 0 0 0 2 2m6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1z" /></svg>
        {#if unread > 0}<span class="smrt-notification-bell__badge" data-unread={unread} data-smrt-part="status">{unread > 99 ? '99+' : unread}</span>{/if}
      </span>
    {:else}
      {heading}{#if unread > 0}<span aria-label={unreadText}> ({unread})</span>{/if}
    {/if}
  </Button>
  {#if open}
    <div bind:this={panel} id={`${instanceId}-panel`} role="dialog" aria-label={heading} tabindex="-1" class="smrt-notification-bell__panel" data-smrt-part="panel">
      <header data-smrt-part="header"><strong>{heading}</strong><Button variant="ghost" size="sm" disabled={unread === 0 || loading} onclick={() => mutate()}>{t(M['ui.notification_bell.mark_all'])}</Button></header>
      {#if error}<p role="alert" data-smrt-part="error">{t(error)}</p>{/if}
      {#if loading}<p role="status" data-smrt-part="status">{t(M['ui.notification_bell.loading'])}</p>{:else if items.length === 0}<p data-smrt-part="empty">{t(M['ui.notification_bell.empty'])}</p>{:else}<ol data-smrt-part="list">
        {#each items as item (item.id)}<li data-read={item.readAt ? 'true' : 'false'} data-smrt-part="row">
          {#if safeHref(item.href)}<a href={safeHref(item.href) ?? undefined} onclick={() => setOpen(false)} data-smrt-part="title">{item.title}</a>{:else}<strong data-smrt-part="title">{item.title}</strong>{/if}
          {#if item.body}<p data-smrt-part="body">{item.body}</p>{/if}
          {#if !item.readAt}<Button variant="ghost" size="sm" onclick={() => mutate(item.id)}>{t(M['ui.notification_bell.mark_one'])}</Button>{/if}
        </li>{/each}
      </ol>{/if}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-notification-bell__root {
    position: relative;
  }
  .smrt-notification-bell__panel {
    position: absolute;
    z-index: 1;
    inset-block-start: 100%;
    inset-inline-end: 0;
    inline-size: min(24rem, 90vw);
    padding: var(--smrt-spacing-3);
  }
  .smrt-notification-bell__icon {
    position: relative;
    display: inline-grid;
    place-items: center;
  }
  .smrt-notification-bell__badge {
    position: absolute;
    inset-block-start: -0.35rem;
    inset-inline-end: -0.5rem;
    min-inline-size: 1rem;
    padding-inline: 0.25rem;
    box-sizing: border-box;
  }
  .smrt-notification-bell__root[data-placement='beside'] .smrt-notification-bell__panel {
    inset-block-start: 0;
    inset-inline-end: auto;
    inset-inline-start: 100%;
    margin-inline-start: var(--smrt-spacing-2);
  }
  header {
    display: flex;
    justify-content: space-between;
    gap: var(--smrt-spacing-2);
  }
  ol {
    display: grid;
    gap: var(--smrt-spacing-2);
    padding: 0;
    list-style: none;
  }
  li {
    padding-block: var(--smrt-spacing-2);
  }
  li[data-read='false'] {
    padding-inline-start: var(--smrt-spacing-2);
  }
  p {
    overflow-wrap: anywhere;
  }
}

@layer smrt.theme {
  .smrt-notification-bell__panel {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-medium);
  }
  .smrt-notification-bell__badge {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    line-height: 1rem;
    text-align: center;
  }
  li {
    border-block-end: var(--smrt-hairline);
  }
  li[data-read='false'] {
    border-inline-start: 3px solid var(--smrt-color-primary);
  }
  /* Notice titles are links: themed like the panel's other text, not the browser's default link blue (#4567). */
  li a {
    color: var(--smrt-color-primary);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }
  li a:hover, li a:focus-visible {
    color: var(--smrt-color-on-surface);
  }
}

</style>
