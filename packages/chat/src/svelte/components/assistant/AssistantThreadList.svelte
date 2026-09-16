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

<div class="assistant-thread-list">
  {#if oncreate}
    <button type="button" class="assistant-thread-list-new" onclick={oncreate}>
      New conversation
    </button>
  {/if}
  <ul>
    {#each threads as thread (thread.id)}
      <li>
        <button
          type="button"
          class:active={thread.id === activeThreadId}
          onclick={() => onselect(thread.id)}
        >
          <span class="title">{thread.title || 'Untitled'}</span>
          {#if thread.messageCount}
            <span class="count">{thread.messageCount}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .assistant-thread-list ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .assistant-thread-list button {
    display: flex;
    justify-content: space-between;
    width: 100%;
    text-align: left;
  }
  .assistant-thread-list button.active {
    font-weight: 600;
  }
</style>
