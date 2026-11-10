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
  class="smrt-assistant-thread-list__root"
  aria-label={t(M['chat.assistant_thread_list.conversations_label'])} data-smrt-component="AssistantThreadList"
>
  {#if oncreate}
    <Button
      type="button"
      variant="ghost"
      onclick={oncreate}
    >
      {t(M['chat.assistant_thread_list.new_conversation'])}
    </Button>
  {/if}
  <ul data-smrt-part="list">
    {#each threads as thread (thread.id)}
      <li>
        <Button
          type="button"
          variant="ghost"
          onclick={() => onselect(thread.id)}
          aria-current={thread.id === activeThreadId ? 'true' : undefined}
        >
          <span class="smrt-assistant-thread-list__title" data-smrt-part="title">
            {thread.title || t(M['chat.assistant_thread_list.untitled'])}
          </span>
          {#if thread.messageCount > 0}
            <span class="smrt-assistant-thread-list__count" data-smrt-part="count">{thread.messageCount}</span>
          {/if}
        </Button>
      </li>
    {/each}
  </ul>
</nav>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-assistant-thread-list__root {
    display: flex;
    flex-direction: column;
    min-width: 160px;
    overflow-y: auto;
  }
  .smrt-assistant-thread-list__root > :global([data-smrt-component="Button"]) {
    margin: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    cursor: pointer;
  }
  .smrt-assistant-thread-list__root ul {
    list-style: none;
    margin: 0;
    padding: 0 var(--smrt-spacing-2) var(--smrt-spacing-2);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
  }
  li > :global([data-smrt-component="Button"]) {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: var(--smrt-spacing-2);
    width: 100%;
    min-width: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    cursor: pointer;
  }
  /* The Button's inner row: title left (clipped with an ellipsis), count right. */
  li > :global([data-smrt-component="Button"] > [data-smrt-part="label"]) {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2);
  }
  .smrt-assistant-thread-list__title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-assistant-thread-list__count {
    flex-shrink: 0;
  }
}

@layer smrt.theme {
  .smrt-assistant-thread-list__root {
    border-right: var(--smrt-hairline);
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-assistant-thread-list__root > :global([data-smrt-component="Button"]) {
    border: 1px dashed var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-medium);
    background: transparent;
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-medium-font, 500 0.8125rem/1.3 sans-serif);
    text-align: left;
  }
  .smrt-assistant-thread-list__root > :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-container);
  }
  li > :global([data-smrt-component="Button"]) {
    border: none;
    border-radius: var(--smrt-radius-medium);
    background: transparent;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.4 sans-serif);
    text-align: left;
  }
  li > :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-container);
  }
  li > :global([data-smrt-component="Button"][aria-current="true"]) {
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-assistant-thread-list__count {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
