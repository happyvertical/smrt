<script lang="ts">
// Think, Hear and Speak as three icon links for the sidebar footer. Each opens
// the AI models page and shows its state: ready (tinted circle), available
// (plain) or off (dashed outline, muted).
import { Icon } from '@happyvertical/smrt-ui';
import { HEAR_ICON, SPEAK_ICON, THINK_ICON } from '../ai/icons.ts';
import { aiState } from '../ai/instance.ts';
import type { CapabilityId } from '../ai/status.ts';
import { appHref } from '../planner/app.svelte.ts';

const icons: Record<CapabilityId, string> = {
  think: THINK_ICON,
  hear: HEAR_ICON,
  speak: SPEAK_ICON,
};
</script>

<div class="ai-status" role="group" aria-label="AI models">
  {#each aiState.capabilities as capability (capability.id)}
    <a
      href={appHref('/ai/')}
      class="cap"
      data-state={capability.state}
      aria-label={capability.label}
      title={capability.label}
    >
      <Icon path={icons[capability.id]} size={20} />
    </a>
  {/each}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .ai-status {
    display: flex;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-2);
  }

  .cap {
    display: inline-grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    border: var(--smrt-hairline);
    border-color: transparent;
    color: var(--smrt-color-on-surface);
    text-decoration: none;
  }

  .cap:hover {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
  }

  .cap:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }

  .cap[data-state='ready'] {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }

  /* Set up elsewhere but not on: dashed and muted. */
  .cap[data-state='available'] {
    border: var(--smrt-hairline-strong);
    border-style: dashed;
    color: var(--smrt-color-on-surface-variant);
  }

  /* Not possible here: dashed, faded and struck through. */
  .cap[data-state='off'] {
    position: relative;
    border: var(--smrt-hairline);
    border-style: dashed;
    color: var(--smrt-color-on-surface-variant);
    opacity: 0.5;
  }

  .cap[data-state='off']::after {
    content: '';
    position: absolute;
    width: 70%;
    height: 0;
    border-top: 2px solid currentColor;
    transform: rotate(-45deg);
  }
}
</style>
