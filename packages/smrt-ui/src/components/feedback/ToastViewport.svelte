<script lang="ts">
import Alert from './Alert.svelte';
import {
  toaster as defaultToaster,
  type Toast,
  type Toaster,
} from './toast.js';

export interface Props {
  /** Toaster instance that manages the toast queue. */
  toaster?: Toaster;
  /** Screen corner where toasts appear. */
  position?:
    | 'top-start'
    | 'top-center'
    | 'top-end'
    | 'bottom-start'
    | 'bottom-center'
    | 'bottom-end';
  /** CSS length inset from the window or anchor region. */
  inset?: string;
  /** Optional content region used for toast placement. */
  anchor?: HTMLElement | null;
  /** CSS class to apply to the viewport container. */
  class?: string;
}
let {
  toaster = defaultToaster,
  position = 'bottom-end',
  class: className = '',
  inset = 'var(--smrt-spacing-4, 1rem)',
  anchor = null,
}: Props = $props();
const instanceId = $props.id();
const hoverReason = `${instanceId}-hover`;
const focusReason = `${instanceId}-focus`;
let toasts = $state<Toast[]>([]);
let bounds = $state<{
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
} | null>(null);

$effect(() => {
  if (!anchor) {
    bounds = null;
    return;
  }
  const region = anchor;
  function measure() {
    const rect = region.getBoundingClientRect();
    bounds = {
      top: rect.top,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      left: rect.left,
      width: rect.width,
    };
  }
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(region);
  window.addEventListener('resize', measure);
  document.addEventListener('scroll', measure, true);
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', measure);
    document.removeEventListener('scroll', measure, true);
  };
});

// A popover outside the topmost modal remains inert. Keep the live region and
// its controls inside the active dialog instead, preserving their Svelte owner.
function followModal(node: HTMLElement) {
  const marker = document.createComment('toast viewport host');
  node.before(marker);
  let stack: HTMLDialogElement[] = [];
  function update(records: MutationRecord[] = []) {
    const dialogs = Array.from(
      document.querySelectorAll<HTMLDialogElement>('dialog[open]'),
    ).filter((dialog) => dialog.matches(':modal'));
    stack = stack.filter((dialog) => dialogs.includes(dialog));
    for (const dialog of dialogs)
      if (!stack.includes(dialog)) stack.push(dialog);
    for (const record of records) {
      if (record.type !== 'attributes' || record.attributeName !== 'open')
        continue;
      const dialog = record.target as HTMLDialogElement;
      if (!dialogs.includes(dialog)) continue;
      stack = [...stack.filter((item) => item !== dialog), dialog];
    }
    const focused = dialogs
      .filter((dialog) => dialog.contains(document.activeElement))
      .at(-1);
    if (focused)
      stack = [...stack.filter((dialog) => dialog !== focused), focused];
    const host = stack.at(-1) ?? marker.parentElement;
    if (!host || node.parentElement === host) return;
    const active = node.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
    if (host === marker.parentElement) marker.after(node);
    else host.append(node);
    active?.focus();
    if (!node.contains(document.activeElement)) {
      for (const toast of toasts) toaster.resume?.(toast.id, focusReason);
    }
  }
  update();
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open'],
  });
  const focus = () => update();
  document.addEventListener('focusin', focus);
  return {
    destroy() {
      observer.disconnect();
      document.removeEventListener('focusin', focus);
      marker.remove();
      node.remove();
    },
  };
}

function handleFocusOut(event: FocusEvent, id: string) {
  if (
    event.currentTarget instanceof HTMLElement &&
    event.relatedTarget instanceof Node &&
    event.currentTarget.contains(event.relatedTarget)
  )
    return;
  toaster.resume?.(id, focusReason);
}

$effect(() => {
  const queue = toaster;
  let ids: string[] = [];
  const unsubscribe = queue.subscribe((next) => {
    ids = next.map((toast) => toast.id);
    toasts = next;
  });
  return () => {
    unsubscribe();
    for (const id of ids) {
      queue.resume?.(id, hoverReason);
      queue.resume?.(id, focusReason);
    }
  };
});

async function runAction(toast: Toast) {
  await toast.action?.run();
  toaster.dismiss(toast.id);
}
</script>

<section use:followModal class="viewport viewport--{position} {className}" aria-label="Notifications" aria-live="polite"
  style:--toast-inset={inset}
  style:--toast-top={bounds ? `${bounds.top}px` : undefined}
  style:--toast-right={bounds ? `${bounds.right}px` : undefined}
  style:--toast-bottom={bounds ? `${bounds.bottom}px` : undefined}
  style:--toast-left={bounds ? `${bounds.left}px` : undefined}
  style:--toast-region-width={bounds ? `${bounds.width}px` : undefined}
>
  {#each toasts as toast (toast.id)}
    <div role="group" aria-label={toast.title ?? 'Notification'}
      onmouseenter={() => toaster.pause?.(toast.id, hoverReason)}
      onmouseleave={() => toaster.resume?.(toast.id, hoverReason)}
      onfocusin={() => toaster.pause?.(toast.id, focusReason)}
      onfocusout={(event) => handleFocusOut(event, toast.id)}
    >
    <Alert variant={toast.variant} title={toast.title} dismissible ondismiss={() => toaster.dismiss(toast.id)}>
      {toast.message}
      {#snippet action()}
        {#if toast.action}<button type="button" onclick={() => runAction(toast)}>{toast.action.label}</button>{/if}
      {/snippet}
    </Alert>
    </div>
  {/each}
</section>

<style>
  .viewport { position: fixed; z-index: var(--smrt-z-index-toast, 1200); display: grid; width: min(24rem, calc(var(--toast-region-width, 100vw) - 2 * var(--toast-inset))); gap: var(--smrt-spacing-2); pointer-events: none; }
  .viewport :global(.alert) { pointer-events: auto; box-shadow: var(--smrt-elevation-3); }
  .viewport--top-start { top: calc(var(--toast-top, 0px) + var(--toast-inset)); left: calc(var(--toast-left, 0px) + var(--toast-inset)); }
  .viewport--top-end { top: calc(var(--toast-top, 0px) + var(--toast-inset)); right: calc(var(--toast-right, 0px) + var(--toast-inset)); }
  .viewport--bottom-start { bottom: calc(var(--toast-bottom, 0px) + var(--toast-inset)); left: calc(var(--toast-left, 0px) + var(--toast-inset)); }
  .viewport--bottom-end { right: calc(var(--toast-right, 0px) + var(--toast-inset)); bottom: calc(var(--toast-bottom, 0px) + var(--toast-inset)); }
  .viewport--top-center, .viewport--bottom-center { left: calc(var(--toast-left, 0px) + var(--toast-region-width, 100vw) / 2); transform: translateX(-50%); }
  .viewport--top-center { top: calc(var(--toast-top, 0px) + var(--toast-inset)); }
  .viewport--bottom-center { bottom: calc(var(--toast-bottom, 0px) + var(--toast-inset)); }
  button { padding: var(--smrt-spacing-1) var(--smrt-spacing-2); border: 1px solid currentColor; border-radius: var(--smrt-radius-small); background: transparent; color: inherit; font: inherit; cursor: pointer; }
</style>
