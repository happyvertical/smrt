<script lang="ts">
/**
 * MessageItem - Individual message row
 * Displays avatar, message bubble, reactions, reply preview, and tool call data.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.messages.js';
import type { ChatMessageData } from '../../types.js';
import Avatar from '../shared/Avatar.svelte';
import MessageBubble from '../shared/MessageBubble.svelte';
import ReactionPicker from '../shared/ReactionPicker.svelte';

const { t } = useI18n();

export interface Props {
  /** Message data to render */
  message: ChatMessageData;
  /** Whether this message was sent by the current user */
  isOwn: boolean;
  /** Reply callback */
  onreply?: (id: string) => void;
  /** React callback */
  onreact?: (id: string, emoji: string) => void;
  /** Edit callback */
  onedit?: (id: string) => void;
  /** Delete callback */
  ondelete?: (id: string) => void;
}

const { message, isOwn, onreply, onreact, onedit, ondelete }: Props = $props();

let showReactionPicker = $state(false);
let showActions = $state(false);

const bubbleVariant = $derived.by(() => {
  if (message.messageType === 'system' || message.messageType === 'action')
    return 'system';
  if (
    message.role === 'assistant' ||
    message.messageType === 'tool_call' ||
    message.messageType === 'tool_result'
  )
    return 'agent';
  return 'default';
});

const formattedTime = $derived.by(() => {
  const d =
    message.createdAt instanceof Date
      ? message.createdAt
      : new Date(message.createdAt);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
});

const hasActions = $derived(
  Boolean(onreact || onreply || (isOwn && (onedit || ondelete))),
);

// Stable id linking the disclosure trigger (aria-controls) to the revealed
// action group. The actions are a labelled group of independently
// keyboard-operable buttons, not an ARIA menu, so the trigger is a plain
// disclosure toggle (aria-expanded) rather than aria-haspopup="menu".
const actionsId = $derived(`message-actions-${message.id}`);

function handleReact(emoji: string) {
  onreact?.(message.id, emoji);
  showReactionPicker = false;
}

function toggleReactionPicker() {
  showReactionPicker = !showReactionPicker;
}

// The "more actions" button is the keyboard/touch-reachable entry point that
// opens the action bar (a11y blocker, T2 #1391). It opens rather than toggles
// so it stays robust against the focus-then-click ordering a tap/keyboard
// activation produces; the bar is dismissed by Escape, blur, or mouse-leave.
function openActions() {
  showActions = true;
}

// Collapse the action bar (and any open picker) once focus leaves the row — the
// keyboard/touch counterpart to onmouseleave so the actions are not hover-only.
function handleFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null;
  const row = event.currentTarget as HTMLElement;
  if (next && row.contains(next)) return;
  showActions = false;
  showReactionPicker = false;
}

// Escape closes the action bar / picker when open. Bound on the window (gated
// on open state) rather than the noninteractive row element so Svelte's
// a11y_no_noninteractive_element_interactions rule stays satisfied.
function handleEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    showReactionPicker = false;
    showActions = false;
  }
}
</script>

<svelte:window
  onkeydown={showActions || showReactionPicker ? handleEscape : undefined}
/>

{#if message.messageType === 'system' || message.messageType === 'action'}
  <div class="message-item message-item--system">
    <MessageBubble content={message.content} isOwn={false} variant="system" />
  </div>
{:else}
  <div
    class="message-item"
    class:message-item--own={isOwn}
    role="article"
    aria-label={t(M['chat.message_item.message_from'], { name: message.senderName })}
    onmouseenter={() => showActions = true}
    onmouseleave={() => { showActions = false; showReactionPicker = false; }}
    onfocusout={handleFocusOut}
  >
    {#if !isOwn}
      <div class="message-item__avatar">
        <Avatar
          name={message.senderName}
          avatarUrl={message.senderAvatarUrl}
          size="sm"
        />
      </div>
    {/if}

    <div class="message-item__body">
      {#if !isOwn}
        <span class="message-item__sender">{message.senderName}</span>
      {/if}

      {#if message.replyTo}
        <div class="message-item__reply-preview">
          <span class="message-item__reply-name">{message.replyTo.senderName}</span>
          <span class="message-item__reply-text">{message.replyTo.content}</span>
        </div>
      {/if}

      <MessageBubble
        content={message.content}
        {isOwn}
        variant={bubbleVariant}
      />

      {#if message.toolCallData}
        <div class="message-item__tool-call">
          <span class="message-item__tool-name">
            {message.toolCallData.toolName}
          </span>
          <span class="message-item__tool-status {message.toolCallData.status}">
            {message.toolCallData.status}
          </span>
          {#if message.toolCallData.duration}
            <span class="message-item__tool-duration">
              {message.toolCallData.duration}ms
            </span>
          {/if}
          {#if message.toolCallData.error}
            <span class="message-item__tool-error">{message.toolCallData.error}</span>
          {/if}
        </div>
      {/if}

      {#if message.reactions.length > 0}
        <div class="message-item__reactions">
          {#each message.reactions as reaction}
            <Button
              variant="ghost"
              size="sm"
              class="message-item__reaction{reaction.reacted ? ' message-item__reaction--active' : ''}"
              type="button"
              onclick={() => onreact?.(message.id, reaction.emoji)}
              aria-label="{reaction.emoji} {reaction.count}"
            >
              <span class="message-item__reaction-emoji">{reaction.emoji}</span>
              <span class="message-item__reaction-count">{reaction.count}</span>
            </Button>
          {/each}
        </div>
      {/if}

      <div class="message-item__meta">
        <span class="message-item__time">{formattedTime}</span>
        {#if message.isEdited}
          <span class="message-item__edited">(edited)</span>
        {/if}
      </div>
    </div>

    {#if hasActions}
      <Button
        variant="ghost"
        size="sm"
        class="message-item__more-btn"
        type="button"
        onclick={openActions}
        onfocus={openActions}
        aria-label={t(M['chat.message_item.more_actions'])}
        aria-expanded={showActions}
        aria-controls={actionsId}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3" cy="8" r="1.3" fill="currentColor" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /><circle cx="13" cy="8" r="1.3" fill="currentColor" /></svg>
      </Button>
    {/if}

    {#if showActions}
      <div
        class="message-item__actions"
        role="group"
        id={actionsId}
        aria-label={t(M['chat.message_item.more_actions'])}
      >
        {#if onreact}
          <Button
            variant="ghost"
            size="sm"
            class="message-item__action-btn"
            type="button"
            onclick={toggleReactionPicker}
            aria-label={t(M['chat.message_item.add_reaction'])}
          >
            <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.2" /><circle cx="5.5" cy="6.5" r="0.8" fill="currentColor" /><circle cx="10.5" cy="6.5" r="0.8" fill="currentColor" /><path d="M5.5 9.5c.5 1.2 1.5 1.8 2.5 1.8s2-.6 2.5-1.8" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" /></svg>
          </Button>
        {/if}
        {#if onreply}
          <Button
            variant="ghost"
            size="sm"
            class="message-item__action-btn"
            type="button"
            onclick={() => onreply?.(message.id)}
            aria-label={t(M['chat.message_item.reply'])}
          >
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M6 3L2 7l4 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /><path d="M2 7h8c2.2 0 4 1.8 4 4v1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </Button>
        {/if}
        {#if isOwn && onedit}
          <Button
            variant="ghost"
            size="sm"
            class="message-item__action-btn"
            type="button"
            onclick={() => onedit?.(message.id)}
            aria-label={t(M['chat.message_item.edit'])}
          >
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M11.5 1.5l3 3L5 14H2v-3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </Button>
        {/if}
        {#if isOwn && ondelete}
          <Button
            variant="ghost"
            size="sm"
            class="message-item__action-btn"
            type="button"
            onclick={() => ondelete?.(message.id)}
            aria-label={t(M['chat.message_item.delete'])}
          >
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 4h12M5.3 4V2.7A.7.7 0 016 2h4a.7.7 0 01.7.7V4m1.6 0v9.3a1.4 1.4 0 01-1.4 1.4H5.1a1.4 1.4 0 01-1.4-1.4V4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </Button>
        {/if}
      </div>

      {#if showReactionPicker}
        <div class="message-item__picker-popover">
          <ReactionPicker isOpen={true} onreact={handleReact} />
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .message-item {
    display: flex;
    align-items: flex-start;
    gap: var(--smrt-spacing-2, 0.375rem);
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-4, 1rem);
    position: relative;
  }

  .message-item--own {
    flex-direction: row-reverse;
  }

  .message-item--system {
    justify-content: center;
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-4, 1rem);
  }

  .message-item__avatar {
    flex-shrink: 0;
    margin-top: var(--smrt-spacing-1, 0.25rem);
  }

  .message-item__body {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
    min-width: 0;
    max-width: 75%;
  }

  .message-item--own .message-item__body {
    align-items: flex-end;
  }

  .message-item__sender {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant, #43474e);
    padding-left: var(--smrt-spacing-1, 0.25rem);
  }

  .message-item__reply-preview {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-3, 0.75rem);
    border-left: 2px solid var(--smrt-color-primary, #005ac1);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface-container-low, #f9fafb);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    max-width: 100%;
    overflow: hidden;
  }

  .message-item__reply-name {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-primary, #005ac1);
  }

  .message-item__reply-text {
    color: var(--smrt-color-on-surface-variant, #43474e);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .message-item__tool-call {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.375rem);
    padding: var(--smrt-spacing-2, 0.375rem) var(--smrt-spacing-3, 0.75rem);
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }

  .message-item__tool-name {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #1b1b1f);
  }

  .message-item__tool-status {
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    text-transform: uppercase;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .message-item__tool-status.pending {
    background: var(--smrt-color-surface-container-high, #e1e3e8);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .message-item__tool-status.running {
    background: var(--smrt-color-primary-container, #e3f2fd);
    color: var(--smrt-color-on-primary-container, #1565c0);
  }

  .message-item__tool-status.success {
    background: var(--smrt-color-success-container, #e8f5e9);
    color: var(--smrt-color-on-success-container, #2e7d32);
  }

  .message-item__tool-status.error {
    background: var(--smrt-color-error-container, #ffebee);
    color: var(--smrt-color-on-error-container, #c62828);
  }

  .message-item__tool-duration {
    color: var(--smrt-color-outline, #74777f);
  }

  .message-item__tool-error {
    color: var(--smrt-color-on-error-container, #c62828);
  }

  .message-item__reactions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1, 0.25rem);
  }

  /* :global() pierces into each Button's rendered <button> (see #1589). */
  .message-item__reactions :global(.message-item__reaction) {
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface, #ffffff);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .message-item__reactions :global(.message-item__reaction:hover) {
    background: var(--smrt-color-surface-container-high, #e1e3e8);
  }

  .message-item__reactions :global(.message-item__reaction--active) {
    border-color: var(--smrt-color-primary, #005ac1);
    background: var(--smrt-color-primary-container, #d6e3ff);
  }

  .message-item__reaction-emoji {
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
    line-height: 1;
  }

  .message-item__reaction-count {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .message-item__meta {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding-left: var(--smrt-spacing-1, 0.25rem);
  }

  .message-item__time {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    color: var(--smrt-color-outline, #74777f);
  }

  .message-item__edited {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    color: var(--smrt-color-outline, #74777f);
    font-style: italic;
  }

  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .message-item :global(.message-item__more-btn) {
    width: 26px;
    height: 26px;
    padding: 0;
    position: absolute;
    top: 0;
    right: var(--smrt-spacing-4, 1rem);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface, #ffffff);
    color: var(--smrt-color-on-surface-variant, #43474e);
    opacity: 0;
    transition: opacity var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .message-item--own :global(.message-item__more-btn) {
    right: auto;
    left: var(--smrt-spacing-4, 1rem);
  }

  /* Reveal the keyboard/touch affordance on hover OR when focus is inside the
     row, so it is never strictly hover-only (a11y blocker, T2 #1391). Always
     visible to coarse pointers (touch) which cannot hover. */
  .message-item:hover :global(.message-item__more-btn),
  .message-item:focus-within :global(.message-item__more-btn) {
    opacity: 1;
  }

  .message-item :global(.message-item__more-btn:focus-visible) {
    opacity: 1;
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 1px;
  }

  @media (hover: none) {
    .message-item :global(.message-item__more-btn) {
      opacity: 1;
    }
  }

  .message-item__actions {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    position: absolute;
    top: 0;
    right: var(--smrt-spacing-4, 1rem);
    background: var(--smrt-color-surface, #ffffff);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-small, 0.25rem);
    padding: var(--smrt-spacing-1, 4px);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px rgba(0, 0, 0, 0.12));
    z-index: 1;
  }

  .message-item--own .message-item__actions {
    right: auto;
    left: var(--smrt-spacing-4, 1rem);
  }

  /* :global() pierces into each Button's rendered <button> (see #1589). */
  .message-item__actions :global(.message-item__action-btn) {
    width: 26px;
    height: 26px;
    padding: 0;
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .message-item__actions :global(.message-item__action-btn:hover) {
    background: var(--smrt-color-surface-container-high, #e1e3e8);
  }

  .message-item__picker-popover {
    position: absolute;
    top: -8px;
    right: var(--smrt-spacing-4, 1rem);
    z-index: 10;
    transform: translateY(-100%);
  }

  .message-item--own .message-item__picker-popover {
    right: auto;
    left: var(--smrt-spacing-4, 1rem);
  }

  @media (prefers-reduced-motion: reduce) {
    .message-item :global(.message-item__more-btn),
    .message-item__actions :global(.message-item__action-btn),
    .message-item__reactions :global(.message-item__reaction) {
      transition: none;
    }
  }
</style>
