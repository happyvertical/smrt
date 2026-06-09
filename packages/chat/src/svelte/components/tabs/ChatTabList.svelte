<script lang="ts">
/**
 * ChatTabList - Minimized tab overview bar
 * Horizontal bar of small avatars/names at bottom. Shows unread badges.
 */
import type { ChatTabState } from '../../types.js';
import Avatar from '../shared/Avatar.svelte';

export interface Props {
  /** Collapsed/minimized tabs */
  tabs: ChatTabState[];
  /** Select (expand) a tab */
  onselect: (roomId: string) => void;
  /** Close a tab */
  onclose: (roomId: string) => void;
}

const { tabs, onselect, onclose }: Props = $props();
</script>

{#if tabs.length > 0}
  <nav class="tab-list" aria-label="Minimized chats">
    {#each tabs as tab (tab.roomId)}
      <div class="tab-list__item">
        <button
          class="tab-list__btn"
          type="button"
          onclick={() => onselect(tab.roomId)}
          aria-label="Open chat with {tab.room.name}"
          title={tab.room.name}
        >
          <Avatar
            name={tab.room.name}
            avatarUrl={tab.room.avatarUrl}
            size="sm"
          />
          {#if tab.unreadCount > 0}
            <span class="tab-list__badge" aria-label="{tab.unreadCount} unread">
              {tab.unreadCount > 99 ? '99+' : tab.unreadCount}
            </span>
          {/if}
        </button>
        <button
          class="tab-list__close"
          type="button"
          onclick={(e) => { e.stopPropagation(); onclose(tab.roomId); }}
          aria-label="Close chat with {tab.room.name}"
          title="Close"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
          </svg>
        </button>
      </div>
    {/each}
  </nav>
{/if}

<style>
  .tab-list {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-1, 4px);
    pointer-events: auto;
  }

  .tab-list__item {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .tab-list__btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: var(--smrt-spacing-2, 8px);
    border: none;
    background: var(--smrt-color-surface-container, #f0f0f4);
    border-radius: var(--smrt-radius-full, 9999px);
    cursor: pointer;
    transition: background var(--smrt-duration-short2, 150ms),
      box-shadow var(--smrt-duration-short2, 150ms);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px rgba(0, 0, 0, 0.1));
  }

  .tab-list__btn:hover {
    background: var(--smrt-color-surface-container-high, #e6e6ea);
    box-shadow: var(--smrt-elevation-2, 0 2px 6px rgba(0, 0, 0, 0.15));
  }

  .tab-list__btn:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
  }

  .tab-list__badge {
    position: absolute;
    top: -2px;
    right: -2px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 var(--smrt-spacing-1, 4px);
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-error, #ba1a1a);
    color: var(--smrt-color-on-error, #ffffff);
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    line-height: 1;
    border: 2px solid var(--smrt-color-surface, #fefbff);
  }

  .tab-list__close {
    display: none;
    position: absolute;
    top: -4px;
    right: -4px;
    width: 18px;
    height: 18px;
    align-items: center;
    justify-content: center;
    border: none;
    background: var(--smrt-color-surface-variant, #e1e2ec);
    color: var(--smrt-color-on-surface-variant, #43474e);
    border-radius: var(--smrt-radius-full, 9999px);
    cursor: pointer;
    padding: 0;
    font-size: 0;
  }

  .tab-list__item:hover .tab-list__close {
    display: inline-flex;
  }

  .tab-list__item:hover .tab-list__badge {
    display: none;
  }

  .tab-list__close:hover {
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
  }

  @media (prefers-reduced-motion: reduce) {
    .tab-list__btn {
      transition: none;
    }
  }
</style>
