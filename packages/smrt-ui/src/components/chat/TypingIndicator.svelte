<script lang="ts">
/**
 * TypingIndicator — animated "…is typing" affordance.
 *
 * The visible dots are decorative (`aria-hidden`); the meaning is carried by an
 * sr-only label inside a polite `role="status"` live region so screen readers
 * hear "<name> is typing" without the animation noise. Honors reduced-motion.
 */
export interface Props {
  /** Who is typing (e.g. "Assistant"). */
  name?: string;
  /** Full label override; defaults to "<name> is typing…" / "Typing…". */
  label?: string;
}

const { name, label }: Props = $props();
const text = $derived(label ?? (name ? `${name} is typing…` : 'Typing…'));
</script>

<div class="typing" role="status" aria-live="polite">
  <span class="typing__sr">{text}</span>
  <span class="typing__dots" aria-hidden="true">
    <span class="typing__dot"></span>
    <span class="typing__dot"></span>
    <span class="typing__dot"></span>
  </span>
</div>

<style>
  .typing {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-large, 12px);
    background: var(--smrt-color-surface-container, #f3edf7);
    width: fit-content;
  }

  .typing__sr {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .typing__dots {
    display: inline-flex;
    gap: var(--smrt-spacing-1, 4px);
  }

  .typing__dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-on-surface-variant, #49454f);
    opacity: 0.5;
    animation: smrt-typing-bounce 1.2s ease-in-out infinite;
  }
  .typing__dot:nth-child(2) {
    animation-delay: 0.2s;
  }
  .typing__dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes smrt-typing-bounce {
    0%,
    60%,
    100% {
      transform: translateY(0);
      opacity: 0.5;
    }
    30% {
      transform: translateY(-3px);
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .typing__dot {
      animation: none;
    }
  }
</style>
