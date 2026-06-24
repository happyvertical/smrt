<script lang="ts">
/**
 * TypingIndicator — animated "…is typing" affordance.
 *
 * The visible dots are decorative (`aria-hidden`); the meaning is carried by an
 * sr-only label inside a polite `role="status"` live region so screen readers
 * hear who is typing without the animation noise. Honors reduced-motion.
 *
 * Pass `names` to announce one or more typists ("Ada is typing", "Ada and Bob
 * are typing", "Ada and 2 others are typing") — an empty list renders nothing.
 * Or pass a single `name` / a full `label` override.
 */
export interface Props {
  /** Who is typing (single). */
  name?: string;
  /** Names of everyone currently typing — aggregated into the label. */
  names?: string[];
  /** Full label override; defaults to an aggregation of `names`/`name`. */
  label?: string;
}

const { name, names, label }: Props = $props();

// Names-mode (an explicit list) renders nothing when nobody is typing; the
// single-`name`/`label` form always renders.
const inNamesMode = $derived(names !== undefined);
const show = $derived(!inNamesMode || (names?.length ?? 0) > 0);

const text = $derived.by(() => {
  if (label) return label;
  if (names && names.length > 0) {
    if (names.length === 1) return `${names[0]} is typing`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
    return `${names[0]} and ${names.length - 1} others are typing`;
  }
  return name ? `${name} is typing…` : 'Typing…';
});
</script>

{#if show}
  <div class="typing" role="status" aria-live="polite">
    <span class="typing__sr">{text}</span>
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
