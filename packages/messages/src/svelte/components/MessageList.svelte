<script lang="ts">
/**
 * MessageList - Unified message list with selection
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { M } from '../i18n.messages.js';
import type { AccountData, MessageData } from '../types.js';
import MessageCard from './MessageCard.svelte';

const { t } = useI18n();

export interface Props {
  /** Array of messages to render in the list. */
  messages: MessageData[];
  /** Set of currently selected message IDs. */
  selected?: Set<string>;
  /** ID of the currently active or open message. */
  activeMessageId?: string;
  /** Accounts for matching senders to display information. */
  accounts?: AccountData[];
  /** Shows a loading indicator while fetching messages. */
  loading?: boolean;
  /** Text to display when the list is empty. */
  emptyMessage?: string;
  /** Called when user clicks on a message to open it. */
  onmessageclick?: (message: MessageData) => void;
  /** Called when user selects a message with checkbox. */
  onselect?: (message: MessageData) => void;
  /** Called when the user flags or unflags a message. */
  onflag?: (message: MessageData) => void;
  /** Shows the message type badge on each row. */
  showType?: boolean;
  /** Shows the sender's account on each row. */
  showAccount?: boolean;
  /** Uses condensed layout for compact display. */
  compact?: boolean;
  /** Custom snippet to render message cards. */
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

<div class="smrt-message-list__root" role="grid" aria-label={t(M['messages.message_list.messages_label'])} data-smrt-component="MessageList">
  {#if loading}
    <div class="smrt-message-list__status" data-smrt-part="status" role="status" aria-live="polite">
      <p>{t(M['messages.message_list.loading'])}</p>
    </div>
  {:else if messages.length === 0}
    <div class="smrt-message-list__empty" data-smrt-part="empty" role="status" aria-live="polite">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-message-list__root {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .smrt-message-list__status,
  .smrt-message-list__empty {
    padding: var(--smrt-spacing-3xl, 3rem);
  }
}

@layer smrt.theme {
  .smrt-message-list__root {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    background: var(--smrt-color-surface);
  }
  .smrt-message-list__status,
  .smrt-message-list__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-list__status p,
  .smrt-message-list__empty p {
    font: var(--smrt-typography-body-large-font, 1.125rem / 1.5 sans-serif);
  }
}

</style>
