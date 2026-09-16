<script lang="ts">
/**
 * AssistantThreadList - sidebar list of assistant threads (#2904).
 */
import type { AssistantThreadSummary } from './assistant-transport.js';

export interface Props {
  threads: AssistantThreadSummary[];
  activeThreadId?: string | null;
  onselect: (threadId: string) => void;
  oncreate?: () => void;
}

const { threads, activeThreadId = null, onselect, oncreate }: Props = $props();
</script>

<nav class="assistant-thread-list" aria-label="Assistant conversations">
  {#if oncreate}
    <button type="button" class="assistant-thread-list-new" onclick={oncreate}>
      + New conversation
    </button>
  {/if}
  <ul>
    {#each threads as thread (thread.id)}
      <li>
        <button
          type="button"
          class="assistant-thread-list-item"
          class:active={thread.id === activeThreadId}
          onclick={() => onselect(thread.id)}
          aria-current={thread.id === activeThreadId ? 'true' : undefined}
        >
          <span class="title">{thread.title || 'Untitled'}</span>
          {#if thread.messageCount > 0}
            <span class="count">{thread.messageCount}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .assistant-thread-list {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    min-width: 160px;
    overflow-y: auto;
  }

  .assistant-thread-list-new {
    margin: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border: 1px dashed var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-medium, 8px);
    background: transparent;
    color: var(--smrt-color-primary, #005ac1);
    font: var(--smrt-typography-label-medium-font, 500 0.8125rem/1.3 sans-serif);
    cursor: pointer;
    text-align: left;
  }

  .assistant-thread-list-new:hover {
    background: var(--smrt-color-surface-container, #f0f0f4);
  }

  .assistant-thread-list ul {
    list-style: none;
    margin: 0;
    padding: 0 var(--smrt-spacing-2, 8px) var(--smrt-spacing-2, 8px);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .assistant-thread-list-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 8px);
    width: 100%;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border: none;
    border-radius: var(--smrt-radius-medium, 8px);
    background: transparent;
    color: var(--smrt-color-on-surface, #1a1c1e);
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.4 sans-serif);
    text-align: left;
    cursor: pointer;
  }

  .assistant-thread-list-item:hover {
    background: var(--smrt-color-surface-container, #f0f0f4);
  }

  .assistant-thread-list-item.active {
    background: var(--smrt-color-secondary-container, #d7e3f8);
    color: var(--smrt-color-on-secondary-container, #0e1d31);
    font-weight: 600;
  }

  .assistant-thread-list-item .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .assistant-thread-list-item .count {
    flex-shrink: 0;
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }
</style>
