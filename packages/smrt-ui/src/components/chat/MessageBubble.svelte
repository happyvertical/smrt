<script lang="ts">
/**
 * MessageBubble — a single chat message, tokenised and a11y-clean.
 *
 * Two complementary forms share one styled container:
 *
 * - **Bare bubble** (the common case for a message list that renders its own
 *   author/time/reactions around each row): pass `content` (or a `children`
 *   snippet) plus the visual `variant` and `own` flag. No header or labelled
 *   group is rendered, so it nests cleanly inside an already-labelled message
 *   row without adding a redundant landmark.
 * - **Self-contained card**: also pass `author` (and optionally `timestamp` /
 *   the `reactions` / `actions` snippets). A header and a labelled
 *   `role="group"` (`<author> (<role>)`) are then rendered so assistive tech can
 *   announce who sent each message.
 *
 * `variant` + `own` are the canonical styling axes. The legacy `role` prop is
 * retained for the card form: it sets the header's role label and derives
 * `variant`/`own` when those are not given.
 */
import type { Snippet } from 'svelte';
import type { ChatMessageRole } from '../../types-generic';

/** Visual tone: a peer message, an assistant message, or a centered notice. */
export type MessageBubbleVariant = 'default' | 'agent' | 'system';

export interface Props {
  /** Visual tone. Canonical styling axis. */
  variant?: MessageBubbleVariant;
  /** Whether the current viewer authored this message — drives alignment + own-color. */
  own?: boolean;
  /**
   * Legacy role. Prefer `variant` + `own`. Sets the header's role label and,
   * when `variant`/`own` are unset, derives them (user → own default, agent →
   * agent, system → system).
   */
  role?: ChatMessageRole;
  /** Plain-text body. Ignored when a `children` snippet is provided. */
  content?: string;
  /** Body snippet (takes precedence over `content`). */
  children?: Snippet;
  /** Display name of the sender. When set, a header + labelled group render. */
  author?: string;
  /** Message time; rendered in a `<time datetime>` element in the header. */
  timestamp?: Date;
  /** Override the visible timestamp text (defaults to a locale time). */
  timestampLabel?: string;
  /** Optional reactions row (e.g. a `ReactionPicker` or reaction chips). */
  reactions?: Snippet;
  /** Optional per-message actions (reply, copy, …). */
  actions?: Snippet;
}

const {
  variant,
  own,
  role = 'user',
  content,
  children,
  author,
  timestamp,
  timestampLabel,
  reactions,
  actions,
}: Props = $props();

// `variant`/`own` are canonical; derive them from the legacy `role` only when
// they are not explicitly supplied.
const effectiveVariant = $derived<MessageBubbleVariant>(
  variant ??
    (role === 'agent' ? 'agent' : role === 'system' ? 'system' : 'default'),
);
const effectiveOwn = $derived(own ?? role === 'user');

// A header + labelled group are rendered only when an author is supplied; a
// bare bubble stays a plain styled container (its host row owns the label).
const hasHeader = $derived(Boolean(author));
const groupLabel = $derived(`${author} (${role})`);
const isoTime = $derived(timestamp ? timestamp.toISOString() : undefined);
const timeText = $derived(
  timestampLabel ?? timestamp?.toLocaleTimeString() ?? '',
);
</script>

<div
  class="bubble bubble--{effectiveVariant}"
  class:bubble--own={effectiveOwn}
  role={hasHeader ? 'group' : undefined}
  aria-label={hasHeader ? groupLabel : undefined}
>
  {#if hasHeader}
    <div class="bubble__header">
      <span class="bubble__author">{author}</span>
      {#if timeText}
        <time class="bubble__time" datetime={isoTime}>{timeText}</time>
      {/if}
    </div>
  {/if}

  <div class="bubble__body">
    {#if children}
      {@render children()}
    {:else if content !== undefined}
      <p class="bubble__content">{content}</p>
    {/if}
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
    max-width: 75%;
    padding: var(--smrt-spacing-3, 12px) var(--smrt-spacing-4, 16px);
    border-radius: var(--smrt-radius-large, 12px);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    line-height: 1.4;
    word-break: break-word;
  }

  /* default — a peer message; `own` is the current viewer's message. */
  .bubble--default {
    background: var(--smrt-color-surface-container, #f3f4f6);
    color: var(--smrt-color-on-surface, #1b1b1f);
    border-bottom-left-radius: var(--smrt-radius-small, 4px);
  }
  .bubble--default.bubble--own {
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    border-bottom-right-radius: var(--smrt-radius-small, 4px);
    border-bottom-left-radius: var(--smrt-radius-large, 12px);
  }

  /* agent — assistant message, accented on the leading edge. */
  .bubble--agent {
    background: var(--smrt-color-tertiary-container, #ffd8e4);
    color: var(--smrt-color-on-tertiary-container, #31111d);
    border-bottom-left-radius: var(--smrt-radius-small, 4px);
    border-left: 3px solid var(--smrt-color-tertiary, #7d5260);
  }
  .bubble--agent.bubble--own {
    border-left: none;
    border-right: 3px solid var(--smrt-color-tertiary, #7d5260);
    border-bottom-right-radius: var(--smrt-radius-small, 4px);
    border-bottom-left-radius: var(--smrt-radius-large, 12px);
  }

  /* system — centered notice. */
  .bubble--system {
    max-width: 100%;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    text-align: center;
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    padding: var(--smrt-spacing-2, 6px) var(--smrt-spacing-4, 16px);
    border-radius: 0;
    align-self: center;
  }

  /* Self-align own messages when laid out in a column (card form). In a host
     row that already aligns own messages this is a harmless no-op. */
  .bubble--own {
    align-self: flex-end;
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
    white-space: pre-wrap;
    word-break: break-word;
  }
  .bubble__content {
    margin: 0;
    white-space: pre-wrap;
  }

  .bubble__reactions,
  .bubble__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1, 4px);
  }
</style>
