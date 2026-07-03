<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy, onMount } from 'svelte';
import { M } from '../../../i18n/strings.workspace.js';
import { useAdminShell } from './context.js';
import type { ShellActivity, ShellActivityEvent } from './types.js';

interface Toast {
  id: string;
  activity: ShellActivity;
  event: ShellActivityEvent['type'];
}

interface Props {
  max?: number;
  /**
   * Which lifecycle events raise a toast. Defaults to lifecycle-only:
   * a newly-created activity ("started") or a status transition
   * (completed / failed / canceled). Progress-only updates keep the same
   * status and carry a `previous` snapshot, so they never toast — otherwise
   * a running job spawns one toast per progress tick.
   */
  notify?: (event: ShellActivityEvent) => boolean;
}

let { max = 4, notify = defaultShouldNotify }: Props = $props();
const { t } = useI18n();
const shell = useAdminShell();
let toasts = $state<Toast[]>([]);
let unwatch: (() => void) | null = null;

function defaultShouldNotify(event: ShellActivityEvent): boolean {
  if (event.type === 'transition') return true;
  return event.type === 'upsert' && !event.previous;
}

function pushToast(event: ShellActivityEvent): void {
  if (event.type === 'remove' || !notify(event)) return;
  const toast = {
    id: `${event.activity.id}:${event.activity.updatedAt ?? Date.now()}`,
    activity: event.activity,
    event: event.type,
  };
  toasts = [toast, ...toasts].slice(0, max);
}

function dismiss(id: string): void {
  toasts = toasts.filter((toast) => toast.id !== id);
}

onMount(() => {
  unwatch = shell.watchActivities(pushToast);
});

onDestroy(() => {
  unwatch?.();
});
</script>

{#if toasts.length > 0}
  <div class="smrt-activity-toasts" aria-live="polite">
    {#each toasts as toast (toast.id)}
      <article class="smrt-activity-toast" data-status={toast.activity.status}>
        <div>
          <strong>{toast.activity.label}</strong>
          <span>{toast.activity.status}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t(M['ui.activity_toasts.dismiss'])}
          onclick={() => dismiss(toast.id)}
        >
          {t(M['ui.activity_toasts.dismiss_action'])}
        </Button>
      </article>
    {/each}
  </div>
{/if}

<style>
  .smrt-activity-toasts {
    position: fixed;
    inset-block-start: var(--smrt-spacing-4);
    inset-inline-end: var(--smrt-spacing-4);
    z-index: var(--smrt-z-index-toast, 1500);
    display: grid;
    gap: var(--smrt-spacing-3);
    inline-size: min(24rem, calc(100vw - var(--smrt-spacing-8)));
  }

  .smrt-activity-toast {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    padding: var(--smrt-spacing-3);
    box-shadow: var(--smrt-elevation-2);
  }

  .smrt-activity-toast div {
    display: grid;
    gap: var(--smrt-spacing-1);
    min-width: 0;
  }

  .smrt-activity-toast strong,
  .smrt-activity-toast span {
    overflow-wrap: anywhere;
  }

  .smrt-activity-toast span {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size);
    text-transform: uppercase;
  }

  @media (prefers-reduced-motion: no-preference) {
    .smrt-activity-toast {
      animation: smrt-activity-toast-in var(--smrt-duration-short3)
        var(--smrt-easing-emphasized-decelerate);
    }
  }

  @keyframes smrt-activity-toast-in {
    from {
      opacity: 0;
      transform: translateY(calc(-1 * var(--smrt-spacing-3)));
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
