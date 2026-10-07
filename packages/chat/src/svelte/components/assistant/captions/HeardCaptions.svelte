<script lang="ts">
import type { CaptionLine } from './caption-state.svelte.js';

export interface Props {
  enabled?: boolean;
  lines?: CaptionLine[];
  interim?: string;
  /** `bottom` overlays an app; `inline` belongs in a panel. */
  placement?: 'bottom' | 'inline';
  maxLines?: number;
  speakerLabel?: string;
}

let {
  enabled = false,
  lines = [],
  interim = '',
  placement = 'bottom',
  maxLines = 3,
  speakerLabel = 'You said',
}: Props = $props();

const visibleLines = $derived(lines.slice(-Math.max(1, maxLines)));
</script>

{#if enabled && (visibleLines.length > 0 || interim)}
  <section class:bottom={placement === 'bottom'} class="heard-captions" aria-label="What you said">
    <p class="speaker">{speakerLabel}</p>
    <div class="caption-lines" aria-live="polite" aria-atomic="false">
      {#each visibleLines as line (line.id)}
        <p>{line.text}</p>
      {/each}
    </div>
    {#if interim}
      <!-- A partial transcript is visually useful but should not repeat the
           final phrase in a screen reader's live region. -->
      <p class="interim" aria-hidden="true">{interim}</p>
    {/if}
  </section>
{/if}

<style>
  .heard-captions { max-inline-size: min(42rem, calc(100vw - 2rem)); padding: .6rem .85rem; border-inline-start: .25rem solid var(--smrt-color-primary, #3154a5); background: color-mix(in srgb, var(--smrt-color-surface, white) 92%, #dce6ff); color: var(--smrt-color-on-surface, #172033); border-radius: .35rem; box-shadow: 0 .25rem .9rem rgb(0 0 0 / .16); }
  .bottom { position: fixed; z-index: 20; inset-inline: 1rem; inset-block-end: max(1rem, env(safe-area-inset-bottom)); margin-inline: auto; }
  .speaker { margin: 0 0 .25rem; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; font-size: .75rem; }
  .caption-lines p, .interim { margin: .15rem 0 0; }
  .interim { font-style: italic; opacity: .8; }
  @media (prefers-reduced-motion: reduce) { .heard-captions { scroll-behavior: auto; } }
</style>
