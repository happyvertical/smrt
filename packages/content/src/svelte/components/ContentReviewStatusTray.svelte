<script lang="ts">
export type ContentReviewStatusTone =
  | 'neutral'
  | 'danger'
  | 'warning'
  | 'success';
export type ContentReviewStatusIcon = 'content' | 'facts' | 'safety' | 'custom';

export interface ContentReviewStatusTrayItem {
  id: string;
  icon: ContentReviewStatusIcon;
  label: string;
  tone: ContentReviewStatusTone;
  status: string;
}

export interface Props {
  items?: ContentReviewStatusTrayItem[];
  activeId?: string | null;
  open?: boolean;
  label?: string;
  onSelect?: (item: ContentReviewStatusTrayItem) => void;
}

let {
  items = [],
  activeId = null,
  open = false,
  label = 'Review status',
  onSelect = undefined,
}: Props = $props();
</script>

{#snippet trayIcon(icon: ContentReviewStatusIcon)}
  {#if icon === 'content'}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 11l2 2 4-4"></path>
      <path d="M8 5h8"></path>
      <path d="M8 19h8"></path>
      <path d="M5 7h14"></path>
      <path d="M5 17h14"></path>
    </svg>
  {:else if icon === 'facts'}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path>
      <path d="M14 2v6h6"></path>
      <path d="M9 15h6"></path>
      <path d="M9 11h2"></path>
    </svg>
  {:else if icon === 'safety'}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path>
      <path d="m9 12 2 2 4-4"></path>
    </svg>
  {:else}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3 1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8Z"></path>
      <path d="m5 15 .9 2.1L8 18l-2.1.9L5 21l-.9-2.1L2 18l2.1-.9Z"></path>
      <path d="m19 14 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9Z"></path>
    </svg>
  {/if}
{/snippet}

{#if items.length > 0}
  <div class="content-review-status-tray" role="group" aria-label={label}>
    {#each items as item (item.id)}
      <button
        type="button"
        aria-pressed={activeId === item.id && open}
        class={`tray-button tray-button--${item.tone}`}
        class:active={activeId === item.id && open}
        title={`${item.label}: ${item.status}`}
        onclick={() => onSelect?.(item)}
      >
        {@render trayIcon(item.icon)}
        <span class="tray-button__indicator" aria-hidden="true"></span>
        <span class="sr-only">{item.label}: {item.status}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .content-review-status-tray {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 2.5rem;
  }

  .tray-button {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.55rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
    padding: 0;
  }

  .tray-button:hover,
  .tray-button.active {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
  }

  .tray-button svg {
    width: 1.15rem;
    height: 1.15rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .tray-button__indicator {
    position: absolute;
    right: 0.35rem;
    bottom: 0.35rem;
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 999px;
    background: var(--smrt-color-outline);
  }

  .tray-button--danger .tray-button__indicator {
    background: var(--smrt-color-error);
  }

  .tray-button--warning .tray-button__indicator {
    background: var(--smrt-color-tertiary, #d97706);
  }

  .tray-button--success .tray-button__indicator {
    background: var(--smrt-color-primary);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
</style>
