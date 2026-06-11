<script lang="ts">
/**
 * MessageBubble — a single chat message with user / agent / system variants.
 *
 * Renders the author + an optional `<time>` timestamp, the message body
 * (`children`), and optional `reactions` / `actions` snippets. The bubble is a
 * labelled `role="group"` (`<author>, <role>`) so assistive tech can navigate
 * messages and announce who sent each one.
 */
import type { Snippet } from 'svelte';
import type { ChatMessageRole } from '../../types-generic';

export interface Props {
  /** Who sent the message. Drives styling and the group label. */
  role?: ChatMessageRole;
  /** Display name of the sender. */
  author?: string;
  /** Message time; rendered in a `<time datetime>` element. */
  timestamp?: Date;
  /** Override the visible timestamp text (defaults to a locale time). */
  timestampLabel?: string;
  /** Message body. */
  children: Snippet;
  /** Optional reactions row (e.g. a `ReactionPicker` or reaction chips). */
  reactions?: Snippet;
  /** Optional per-message actions (reply, copy, …). */
  actions?: Snippet;
}

const {
  role = 'user',
  author,
  timestamp,
  timestampLabel,
  children,
  reactions,
  actions,
}: Props = $props();

const roleNoun: Record<ChatMessageRole, string> = {
  user: 'You',
  agent: 'Assistant',
  system: 'System',
};

const groupLabel = $derived(`${author ?? roleNoun[role]} (${role})`);
const isoTime = $derived(timestamp ? timestamp.toISOString() : undefined);
const timeText = $derived(
  timestampLabel ?? timestamp?.toLocaleTimeString() ?? '',
);
</script>

<div class="bubble bubble--{role}" role="group" aria-label={groupLabel}>
  <div class="bubble__header">
    <span class="bubble__author">{author ?? roleNoun[role]}</span>
    {#if timeText}
      <time class="bubble__time" datetime={isoTime}>{timeText}</time>
    {/if}
  </div>

  <div class="bubble__body">
    {@render children()}
  </div>

  {#if reactions}
    <div class="bubble__reactions">{@render reactions()}</div>
  {/if}

  {#if actions}
    <div class="bubble__actions">{@render actions()}</div>
  {/if}
</div>

<style>
  .bubble {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    max-width: 42rem;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-large, 12px);
    background: var(--smrt-color-surface-container, #f3edf7);
    color: var(--smrt-color-on-surface);
  }

  .bubble--user {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    align-self: flex-end;
  }
  .bubble--system {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
    align-self: center;
    font-style: italic;
  }

  .bubble__header {
    display: flex;
    align-items: baseline;
    gap: var(--smrt-spacing-2, 8px);
  }
  .bubble__author {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }
  .bubble__time {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    color: var(--smrt-color-on-surface-variant, #49454f);
    opacity: 0.8;
  }

  .bubble__body {
    font-size: var(--smrt-typography-body-medium-size, 1rem);
    line-height: var(--smrt-typography-body-medium-line-height, 1.5);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .bubble__reactions,
  .bubble__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1, 4px);
  }
</style>
