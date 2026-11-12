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
  <section class="smrt-heard-captions__root" aria-label={speakerLabel} data-smrt-component="HeardCaptions">
    <p class="smrt-heard-captions__speaker" data-smrt-part="label">{speakerLabel}</p>
    <div class="smrt-heard-captions__lines" data-smrt-part="body" aria-live="polite" aria-atomic="false">
      {#each visibleLines as line (line.id)}
        <p>{line.text}</p>
      {/each}
    </div>
    {#if interim}
      <!-- A partial transcript is visually useful but should not repeat the
           final phrase in a screen reader's live region. -->
      <p class="smrt-heard-captions__interim" data-smrt-part="message" aria-hidden="true">{interim}</p>
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
  .smrt-heard-captions__root {
    box-sizing: border-box;
    min-inline-size: 0;
    max-inline-size: min(42rem, calc(100vw - 2rem));
    overflow-wrap: anywhere;
    padding: .6rem .85rem;
  }
  .smrt-heard-captions__speaker {
    margin: 0 0 .25rem;
  }
  .smrt-heard-captions__lines p, .smrt-heard-captions__interim {
    margin: .15rem 0 0;
  }
}

@layer smrt.theme {
  .smrt-heard-captions__root {
    border-inline-start: .25rem solid var(--smrt-color-primary);
    background: color-mix(in srgb, var(--smrt-color-surface, white) 92%, var(--smrt-color-primary-container));
    color: var(--smrt-color-on-surface);
    border-radius: .35rem;
    box-shadow: var(--smrt-elevation-4, 0 .25rem .9rem color-mix(in srgb, var(--smrt-color-shadow, black) 16%, transparent));
  }
  .smrt-heard-captions__speaker {
    font-weight: var(--smrt-typography-weight-bold, 700);
    letter-spacing: .03em;
    text-transform: uppercase;
    font-size: var(--smrt-typography-label-medium-size, .75rem);
  }
  .smrt-heard-captions__interim {
    font-style: italic;
    opacity: .8;
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-heard-captions__root {
      scroll-behavior: auto;
    }
  }
}

</style>
