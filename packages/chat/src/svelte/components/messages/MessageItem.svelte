<script lang="ts">
/**
 * MessageItem - Individual message row
 * Displays avatar, message bubble, reactions, reply preview, and tool call data.
 */

import { MessageBubble } from '@happyvertical/smrt-ui/chat';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.messages.js';
import type { ChatMessageData } from '../../types.js';
import Avatar from '../shared/Avatar.svelte';
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
  <div class="smrt-message-item__root smrt-message-item__system" data-smrt-component="MessageItem">
    <MessageBubble content={message.content} own={false} variant="system" />
  </div>
{:else}
  <div
    class="smrt-message-item__root"
    role="article"
    aria-label={t(M['chat.message_item.message_from'], { name: message.senderName })}
    onmouseenter={() => showActions = true}
    class:smrt-message-item__own={isOwn}
    onmouseleave={() => { showActions = false; showReactionPicker = false; }}
    onfocusout={handleFocusOut} data-smrt-component="MessageItem"
  >
    {#if !isOwn}
      <div class="smrt-message-item__avatar" data-smrt-part="avatar">
        <Avatar
          name={message.senderName}
          avatarUrl={message.senderAvatarUrl}
          size="sm"
        />
      </div>
    {/if}

    <div class="smrt-message-item__body" data-smrt-part="body">
      {#if !isOwn}
        <span class="smrt-message-item__sender" data-smrt-part="label">{message.senderName}</span>
      {/if}

      {#if message.replyTo}
        <div class="smrt-message-item__reply" data-smrt-part="reply">
          <span class="smrt-message-item__reply-label" data-smrt-part="reply-label">{message.replyTo.senderName}</span>
          <span class="smrt-message-item__reply-message" data-smrt-part="reply-message">{message.replyTo.content}</span>
        </div>
      {/if}

      <MessageBubble
        content={message.content}
        own={isOwn}
        variant={bubbleVariant}
      />

      {#if message.toolCallData}
        <div class="smrt-message-item__tool" data-smrt-part="tool">
          <span class="smrt-message-item__tool-name" data-smrt-part="tool-name">
            {message.toolCallData.toolName}
          </span>
          <span class="smrt-message-item__status smrt-message-item__{message.toolCallData.status}" data-smrt-part="status">
            {message.toolCallData.status}
          </span>
          {#if message.toolCallData.duration}
            <span class="smrt-message-item__duration" data-smrt-part="duration">
              {message.toolCallData.duration}ms
            </span>
          {/if}
          {#if message.toolCallData.error}
            <span class="smrt-message-item__error" data-smrt-part="error">{message.toolCallData.error}</span>
          {/if}
        </div>
      {/if}

      {#if message.reactions.length > 0}
        <div class="smrt-message-item__reactions" data-smrt-part="reactions">
          {#each message.reactions as reaction}
            <Button
              variant="ghost"
              size="sm"
              class={reaction.reacted ? 'smrt-message-item__reaction--active' : ''}
              type="button"
              onclick={() => onreact?.(message.id, reaction.emoji)}
              aria-label="{reaction.emoji} {reaction.count}"
            >
              <span class="smrt-message-item__emoji" data-smrt-part="emoji">{reaction.emoji}</span>
              <span class="smrt-message-item__count" data-smrt-part="count">{reaction.count}</span>
            </Button>
          {/each}
        </div>
      {/if}

      <div class="smrt-message-item__meta" data-smrt-part="meta">
        <span class="smrt-message-item__time" data-smrt-part="time">{formattedTime}</span>
        {#if message.isEdited}
          <span class="smrt-message-item__edited" data-smrt-part="edited">(edited)</span>
        {/if}
      </div>
    </div>

    {#if hasActions}
      <Button
        variant="ghost"
        size="sm"
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
        class="smrt-message-item__actions"
        data-smrt-part="actions"
        role="group"
        id={actionsId}
        aria-label={t(M['chat.message_item.more_actions'])}
      >
        {#if onreact}
          <Button
            variant="ghost"
            size="sm"
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
            type="button"
            onclick={() => ondelete?.(message.id)}
            aria-label={t(M['chat.message_item.delete'])}
          >
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 4h12M5.3 4V2.7A.7.7 0 016 2h4a.7.7 0 01.7.7V4m1.6 0v9.3a1.4 1.4 0 01-1.4 1.4H5.1a1.4 1.4 0 01-1.4-1.4V4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </Button>
        {/if}
      </div>

      {#if showReactionPicker}
        <div class="smrt-message-item__picker" data-smrt-part="picker">
          <ReactionPicker isOpen={true} onreact={handleReact} />
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-message-item__root {
    display: flex;
    align-items: flex-start;
    gap: var(--smrt-spacing-2, 0.375rem);
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-4, 1rem);
    position: relative;
  }
  .smrt-message-item__own {
    flex-direction: row-reverse;
  }
  .smrt-message-item__system {
    justify-content: center;
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-4, 1rem);
  }
  .smrt-message-item__avatar {
    flex-shrink: 0;
    margin-top: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-message-item__body {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
    min-width: 0;
    max-width: 75%;
  }
  .smrt-message-item__own .smrt-message-item__body {
    align-items: flex-end;
  }
  .smrt-message-item__sender {
    padding-left: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-message-item__reply {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-3, 0.75rem);
    max-width: 100%;
    overflow: hidden;
  }
  .smrt-message-item__reply-message {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-message-item__tool {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.375rem);
    padding: var(--smrt-spacing-2, 0.375rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-message-item__status {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  .smrt-message-item__reactions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
  /* :global() pierces into each Button's rendered <button> (see #1589). */
  .smrt-message-item__reactions :global([data-smrt-component="Button"]) {
    gap: var(--smrt-spacing-1);
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  .smrt-message-item__meta {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding-left: var(--smrt-spacing-1, 0.25rem);
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-message-item__root > :global([data-smrt-component="Button"]) {
    width: 26px;
    height: 26px;
    padding: 0;
    position: absolute;
    top: 0;
    right: var(--smrt-spacing-4, 1rem);
    opacity: 0;
  }
  .smrt-message-item__own > :global([data-smrt-component="Button"]) {
    right: auto;
    left: var(--smrt-spacing-4, 1rem);
  }
  .smrt-message-item__actions {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
    position: absolute;
    top: 0;
    right: var(--smrt-spacing-4, 1rem);
    padding: var(--smrt-spacing-1);
    z-index: 1;
  }
  .smrt-message-item__own .smrt-message-item__actions {
    right: auto;
    left: var(--smrt-spacing-4, 1rem);
  }
  /* :global() pierces into each Button's rendered <button> (see #1589). */
  .smrt-message-item__actions :global([data-smrt-component="Button"]) {
    width: 26px;
    height: 26px;
    padding: 0;
  }
  /* Reveal the keyboard/touch affordance on hover OR when focus is inside the
  row, so it is never strictly hover-only (a11y blocker, T2 #1391). Always
  visible to coarse pointers (touch) which cannot hover. */
  .smrt-message-item__root:hover > :global([data-smrt-component="Button"]),
  .smrt-message-item__root:focus-within > :global([data-smrt-component="Button"]) {
    opacity: 1;
  }
  .smrt-message-item__root > :global([data-smrt-component="Button"]:focus-visible) {
    opacity: 1;
  }
  @media (hover: none) {
    .smrt-message-item__root > :global([data-smrt-component="Button"]) {
      opacity: 1;
    }
  }
  .smrt-message-item__picker {
    position: absolute;
    top: -8px;
    right: var(--smrt-spacing-4, 1rem);
    z-index: 10;
    transform: translateY(-100%);
  }
  .smrt-message-item__own .smrt-message-item__picker {
    right: auto;
    left: var(--smrt-spacing-4, 1rem);
  }
}

@layer smrt.theme {
  .smrt-message-item__sender {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-item__reply {
    border-left: 2px solid var(--smrt-color-primary);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface-container-low);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
  .smrt-message-item__reply-label {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-primary);
  }
  .smrt-message-item__reply-message {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-item__tool {
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }
  .smrt-message-item__tool-name {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-message-item__status {
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    text-transform: uppercase;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-message-item__status.smrt-message-item__pending {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-item__status.smrt-message-item__running {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-message-item__status.smrt-message-item__success {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-message-item__status.smrt-message-item__error {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-message-item__duration {
    color: var(--smrt-color-outline);
  }
  .smrt-message-item__error {
    color: var(--smrt-color-on-error-container);
  }
  /* :global() pierces into each Button's rendered <button> (see #1589). */
  .smrt-message-item__reactions :global([data-smrt-component="Button"]) {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-message-item__reactions :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-message-item__reactions :global(.smrt-message-item__reaction--active) {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }
  .smrt-message-item__emoji {
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
    line-height: 1;
  }
  .smrt-message-item__count {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-item__time {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    color: var(--smrt-color-outline);
  }
  .smrt-message-item__edited {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    color: var(--smrt-color-outline);
    font-style: italic;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-message-item__root > :global([data-smrt-component="Button"]) {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface-variant);
    transition: opacity var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-message-item__root > :global([data-smrt-component="Button"]:focus-visible) {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 1px;
  }
  .smrt-message-item__actions {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-small, 0.25rem);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px rgba(0, 0, 0, 0.12));
  }
  /* :global() pierces into each Button's rendered <button> (see #1589). */
  .smrt-message-item__actions :global([data-smrt-component="Button"]) {
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-message-item__actions :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-container-high);
  }
  /* Reveal the keyboard/touch affordance on hover OR when focus is inside the
  row, so it is never strictly hover-only (a11y blocker, T2 #1391). Always
  visible to coarse pointers (touch) which cannot hover. */
  .smrt-message-item__root:hover > :global([data-smrt-component="Button"]),
  .smrt-message-item__root:focus-within > :global([data-smrt-component="Button"]) {
    opacity: 1;
  }
  .smrt-message-item__root > :global([data-smrt-component="Button"]:focus-visible) {
    opacity: 1;
  }
  @media (hover: none) {
    .smrt-message-item__root > :global([data-smrt-component="Button"]) {
      opacity: 1;
    }
  }
  .smrt-message-item__picker {
    /* The picker primitive supplies its own surface + radius; the popover
    wrapper lifts it off the conversation with matching elevation. */
    border-radius: var(--smrt-radius-large, 0.75rem);
    box-shadow: var(--smrt-elevation-2, 0 2px 6px rgba(0, 0, 0, 0.15));
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-message-item__root > :global([data-smrt-component="Button"]),
    .smrt-message-item__actions :global([data-smrt-component="Button"]),
    .smrt-message-item__reactions :global([data-smrt-component="Button"]) {
      transition: none;
    }
  }
}

</style>
