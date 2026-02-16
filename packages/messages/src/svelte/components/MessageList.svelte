<script lang="ts">
/**
 * MessageList - Unified message list with selection
 */
import type { Snippet } from 'svelte';
import type { AccountData, MessageData } from '../types.js';
import MessageCard from './MessageCard.svelte';

export interface Props {
  messages: MessageData[];
  selected?: Set<string>;
  activeMessageId?: string;
  accounts?: AccountData[];
  loading?: boolean;
  emptyMessage?: string;
  onmessageclick?: (message: MessageData) => void;
  onselect?: (message: MessageData) => void;
  onflag?: (message: MessageData) => void;
  showType?: boolean;
  showAccount?: boolean;
  compact?: boolean;
  card?: Snippet<[{ message: MessageData }]>;
}

const {
  messages,
  selected = new Set(),
  activeMessageId,
  accounts = [],
  loading = false,
  emptyMessage = 'No messages found.',
  onmessageclick,
  onselect,
  onflag,
  showType = true,
  showAccount = false,
  compact = false,
  card,
}: Props = $props();

function getAccount(accountId: string): AccountData | undefined {
  return accounts.find((a) => a.id === accountId);
}
</script>

<div class="message-list" role="grid" aria-label="Messages">
  {#if loading}
    <div class="loading" role="status" aria-live="polite">
      <p>Loading messages...</p>
    </div>
  {:else if messages.length === 0}
    <div class="empty" role="status" aria-live="polite">
      <p>{emptyMessage}</p>
    </div>
  {:else}
    {#each messages as message (message.id)}
      {#if card}
        {@render card({ message })}
      {:else}
        <MessageCard
          {message}
          selected={selected.has(message.id)}
          {compact}
          {showType}
          {showAccount}
          account={showAccount ? getAccount(message.accountId) : undefined}
          onclick={onmessageclick}
          {onselect}
          {onflag}
        />
      {/if}
    {/each}
  {/if}
</div>

<style>
  .message-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    overflow: hidden;
    background: var(--smrt-color-surface, #fefbff);
  }

  .loading,
  .empty {
    text-align: center;
    padding: var(--smrt-spacing-3xl, 3rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .loading p,
  .empty p {
    font: var(--smrt-typography-body-large-font, 1.125rem / 1.5 sans-serif);
  }
</style>
