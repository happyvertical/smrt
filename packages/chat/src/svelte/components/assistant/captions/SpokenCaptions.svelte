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
const inOverlay = getContext<boolean>(CAPTION_OVERLAY) ?? false;
const visibleLines = $derived(lines.slice(-Math.max(1, maxLines)));
</script>

{#snippet surface()}
  <section class="smrt-spoken-captions__root" aria-label={speakerLabel} data-smrt-component="SpokenCaptions">
    <p class="smrt-spoken-captions__speaker" data-smrt-part="label"><span aria-hidden="true">◈</span> {speakerLabel}</p>
    <div class="smrt-spoken-captions__lines" data-smrt-part="body" aria-live={announce ? 'polite' : 'off'} aria-atomic="false">
      {#each visibleLines as line (line.id)}
        <p>{line.text}</p>
      {/each}
    </div>
    {#if interim}
      <p class="smrt-spoken-captions__interim" data-smrt-part="preview" aria-hidden="true">{interim}</p>
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-spoken-captions__root {
    box-sizing: border-box;
    min-inline-size: 0;
    max-inline-size: min(42rem, calc(100vw - 2rem));
    overflow-wrap: anywhere;
    padding: .7rem .9rem;
  }
  .smrt-spoken-captions__speaker {
    margin: 0 0 .3rem;
  }
  .smrt-spoken-captions__lines p, .smrt-spoken-captions__interim {
    margin: .18rem 0 0;
  }
}

@layer smrt.theme {
  .smrt-spoken-captions__root {
    border: 2px solid var(--smrt-color-outline);
    background: var(--smrt-color-inverse-surface);
    color: var(--smrt-color-inverse-on-surface);
    border-radius: 1rem;
    box-shadow: var(--smrt-elevation-4, 0 .35rem 1.2rem color-mix(in srgb, var(--smrt-color-shadow, black) 28%, transparent));
  }
  .smrt-spoken-captions__speaker {
    font-weight: var(--smrt-typography-weight-bold, 700);
    font-size: var(--smrt-typography-label-medium-size, .8rem);
  }
  .smrt-spoken-captions__interim {
    opacity: .8;
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-spoken-captions__root {
      scroll-behavior: auto;
    }
  }
}

</style>
