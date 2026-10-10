<script lang="ts">
import { getContext } from 'svelte';
import CaptionOverlay from './CaptionOverlay.svelte';
import { CAPTION_OVERLAY } from './caption-overlay-context.js';
import type { CaptionLine } from './caption-state.svelte.js';

export interface Props {
  /** Shows captions when the host enables this speaker surface. */
  enabled?: boolean;
  /** Completed caption lines in chronological order. */
  lines?: CaptionLine[];
  /** Current unfinished transcript displayed without live announcement. */
  interim?: string;
  /** `bottom` overlays an app; `inline` belongs in a panel. */
  placement?: 'bottom' | 'inline';
  /** Maximum number of completed lines retained on screen. */
  maxLines?: number;
  /** Localized visible and accessible label identifying the speaker. */
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

const inOverlay = getContext<boolean>(CAPTION_OVERLAY) ?? false;
const visibleLines = $derived(lines.slice(-Math.max(1, maxLines)));
</script>

{#snippet surface()}
  <section class="heard-captions" aria-label={speakerLabel}>
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
{/snippet}

{#if enabled && (visibleLines.length > 0 || interim)}
  {#if placement === 'bottom' && !inOverlay}
    <CaptionOverlay>{@render surface()}</CaptionOverlay>
  {:else}
    {@render surface()}
  {/if}
{/if}

<style>
  .heard-captions { box-sizing: border-box; min-inline-size: 0; max-inline-size: min(42rem, calc(100vw - 2rem)); overflow-wrap: anywhere; padding: .6rem .85rem; border-inline-start: .25rem solid var(--smrt-color-primary, #3154a5); background: color-mix(in srgb, var(--smrt-color-surface, white) 92%, var(--smrt-color-primary-container, #dce6ff)); color: var(--smrt-color-on-surface, #172033); border-radius: .35rem; box-shadow: var(--smrt-elevation-4, 0 .25rem .9rem color-mix(in srgb, var(--smrt-color-shadow, black) 16%, transparent)); }
  .speaker { margin: 0 0 .25rem; font-weight: var(--smrt-typography-weight-bold, 700); letter-spacing: .03em; text-transform: uppercase; font-size: var(--smrt-typography-label-medium-size, .75rem); }
  .caption-lines p, .interim { margin: .15rem 0 0; }
  .interim { font-style: italic; opacity: .8; }
  @media (prefers-reduced-motion: reduce) { .heard-captions { scroll-behavior: auto; } }
</style>
