<script lang="ts">
/**
 * AssistantThreadList - sidebar list of assistant threads (#2904).
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.js';
import type { AssistantThreadSummary } from './assistant-transport.js';

const { t } = useI18n();

export interface Props {
  /** Threads to list, most-recent-first order left to the caller. */
  threads: AssistantThreadSummary[];
  /** The currently open thread id, highlighted and `aria-current`. */
  activeThreadId?: string | null;
  /** Fired with a thread's id when the user clicks its row. */
  onselect: (threadId: string) => void;
  /** Shown as a "+ New conversation" row when present; fired on click. */
  oncreate?: () => void;
}

const { threads, activeThreadId = null, onselect, oncreate }: Props = $props();
</script>

<nav
  class="assistant-thread-list"
  aria-label={t(M['chat.assistant_thread_list.conversations_label'])} data-smrt-component="AssistantThreadList"
>
  {#if oncreate}
    <Button
      type="button"
      variant="ghost"
      class="assistant-thread-list-new"
      onclick={oncreate}
    >
      {t(M['chat.assistant_thread_list.new_conversation'])}
    </Button>
  {/if}
  <ul>
    {#each threads as thread (thread.id)}
      <li>
        <Button
          type="button"
          variant="ghost"
          class={thread.id === activeThreadId
            ? 'assistant-thread-list-item active'
            : 'assistant-thread-list-item'}
          onclick={() => onselect(thread.id)}
          aria-current={thread.id === activeThreadId ? 'true' : undefined}
        >
          <span class="title">
            {thread.title || t(M['chat.assistant_thread_list.untitled'])}
          </span>
          {#if thread.messageCount > 0}
            <span class="count">{thread.messageCount}</span>
          {/if}
        </Button>
      </li>
    {/each}
  </ul>
</nav>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .assistant-thread-list {
    display: flex;
    flex-direction: column;
    border-right: var(--smrt-hairline);
    background: var(--smrt-color-surface-container-low);
    min-width: 160px;
    overflow-y: auto;
  }

  :global(.assistant-thread-list-new) {
    margin: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: 1px dashed var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-medium);
    background: transparent;
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-medium-font, 500 0.8125rem/1.3 sans-serif);
    cursor: pointer;
    text-align: left;
  }

  :global(.assistant-thread-list-new:hover) {
    background: var(--smrt-color-surface-container);
  }

  .assistant-thread-list ul {
    list-style: none;
    margin: 0;
    padding: 0 var(--smrt-spacing-2) var(--smrt-spacing-2);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
  }

  :global(.assistant-thread-list-item) {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: var(--smrt-spacing-2);
    width: 100%;
    min-width: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: none;
    border-radius: var(--smrt-radius-medium);
    background: transparent;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.4 sans-serif);
    text-align: left;
    cursor: pointer;
  }

  /* The Button's inner row: title left (clipped with an ellipsis), count right. */
  :global(.assistant-thread-list-item > [data-smrt-part="label"]) {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2);
  }

  :global(.assistant-thread-list-item:hover) {
    background: var(--smrt-color-surface-container);
  }

  :global(.assistant-thread-list-item.active) {
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    flex-shrink: 0;
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
}
</style>
