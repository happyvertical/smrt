<script lang="ts">
import type { CaptionLine } from './caption-state.svelte.js';

export interface Props {
  enabled?: boolean;
  lines?: CaptionLine[];
  interim?: string;
  placement?: 'bottom' | 'inline';
  maxLines?: number;
  speakerLabel?: string;
  /** Spoken audio already conveys this text. Opt in only when needed. */
  announce?: boolean;
}

let {
  enabled = false,
  lines = [],
  interim = '',
  placement = 'bottom',
  maxLines = 3,
  speakerLabel = 'Assistant is speaking',
  announce = false,
}: Props = $props();
const visibleLines = $derived(lines.slice(-Math.max(1, maxLines)));
</script>

{#if enabled && (visibleLines.length > 0 || interim)}
  <section class:bottom={placement === 'bottom'} class="spoken-captions" aria-label="Assistant speech">
    <p class="speaker"><span aria-hidden="true">◈</span> {speakerLabel}</p>
    <div class="caption-lines" aria-live={announce ? 'polite' : 'off'} aria-atomic="false">
      {#each visibleLines as line (line.id)}
        <p>{line.text}</p>
      {/each}
    </div>
    {#if interim}
      <p class="interim" aria-hidden="true">{interim}</p>
    {/if}
  </section>
{/if}

<style>
  .spoken-captions { max-inline-size: min(42rem, calc(100vw - 2rem)); padding: .7rem .9rem; border: 2px solid var(--smrt-color-outline, #533b72); background: var(--smrt-color-inverse-surface, #221c2c); color: var(--smrt-color-inverse-on-surface, #fff7ff); border-radius: 1rem; box-shadow: 0 .35rem 1.2rem rgb(0 0 0 / .28); }
  .bottom { position: fixed; z-index: 21; inset-inline: 1rem; inset-block-end: max(1rem, env(safe-area-inset-bottom)); margin-inline: auto; }
  .speaker { margin: 0 0 .3rem; font-weight: 700; font-size: .8rem; }
  .caption-lines p, .interim { margin: .18rem 0 0; }
  .interim { opacity: .8; }
  @media (prefers-reduced-motion: reduce) { .spoken-captions { scroll-behavior: auto; } }
</style>
