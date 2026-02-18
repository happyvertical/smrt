<script lang="ts">
/**
 * TypingIndicator - Animated "typing..." display
 * Shows "Alice is typing..." or "Alice and Bob are typing..." with animated dots.
 */

export interface Props {
  /** Names of users currently typing */
  names: string[];
}

const { names }: Props = $props();

const label = $derived.by(() => {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names[0]} and ${names.length - 1} others are typing`;
});
</script>

{#if names.length > 0}
  <div class="typing" aria-live="polite" aria-label="{label}">
    <span class="typing__text">{label}</span>
    <span class="typing__dots" aria-hidden="true">
      <span class="typing__dot"></span>
      <span class="typing__dot"></span>
      <span class="typing__dot"></span>
    </span>
  </div>
{/if}

<style>
  .typing {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-3, 0.75rem);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .typing__text {
    white-space: nowrap;
  }

  .typing__dots {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .typing__dot {
    width: 4px;
    height: 4px;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-on-surface-variant, #43474e);
    animation: typing-bounce 1.4s infinite ease-in-out both;
  }

  .typing__dot:nth-child(1) {
    animation-delay: 0s;
  }

  .typing__dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .typing__dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes typing-bounce {
    0%, 80%, 100% {
      opacity: 0.3;
      transform: scale(0.8);
    }
    40% {
      opacity: 1;
      transform: scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .typing__dot {
      animation: none;
      opacity: 0.6;
    }
  }
</style>
