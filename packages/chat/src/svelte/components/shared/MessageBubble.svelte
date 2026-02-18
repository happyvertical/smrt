<script lang="ts">
/**
 * MessageBubble - Styled message bubble
 * Different styling for own messages, others' messages, agent, and system.
 */

export interface Props {
  /** Message content text */
  content: string;
  /** Whether this message was sent by the current user */
  isOwn: boolean;
  /** Visual variant of the bubble */
  variant?: 'default' | 'agent' | 'system';
}

const { content, isOwn, variant = 'default' }: Props = $props();
</script>

<div
  class="bubble {variant}"
  class:own={isOwn}
>
  <p class="bubble__content">{content}</p>
</div>

<style>
  .bubble {
    max-width: 75%;
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
    border-radius: var(--smrt-radius-large, 1rem);
    word-break: break-word;
    line-height: 1.4;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .bubble__content {
    margin: 0;
    white-space: pre-wrap;
  }

  /* Default variant - received */
  .default {
    background: var(--smrt-color-surface-container, #f3f4f6);
    color: var(--smrt-color-on-surface, #1b1b1f);
    border-bottom-left-radius: var(--smrt-radius-small, 0.25rem);
  }

  /* Default variant - own message */
  .default.own {
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    border-bottom-right-radius: var(--smrt-radius-small, 0.25rem);
    border-bottom-left-radius: var(--smrt-radius-large, 1rem);
  }

  /* Agent variant */
  .agent {
    background: var(--smrt-color-tertiary-container, #ffd8e4);
    color: var(--smrt-color-on-tertiary-container, #31111d);
    border-bottom-left-radius: var(--smrt-radius-small, 0.25rem);
    border-left: 3px solid var(--smrt-color-tertiary, #7d5260);
  }

  .agent.own {
    border-left: none;
    border-right: 3px solid var(--smrt-color-tertiary, #7d5260);
    border-bottom-right-radius: var(--smrt-radius-small, 0.25rem);
    border-bottom-left-radius: var(--smrt-radius-large, 1rem);
  }

  /* System variant */
  .system {
    max-width: 100%;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    text-align: center;
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    padding: var(--smrt-spacing-2, 0.375rem) var(--smrt-spacing-4, 1rem);
    border-radius: 0;
  }
</style>
