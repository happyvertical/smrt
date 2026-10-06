<script lang="ts">
import { appHref } from '../planner/app.svelte.ts';

/**
 * Placeholder for the in-browser assistant (follow-up issue #3). It fills the
 * smrt-start dock slot; the real `AssistantDock` and its browser transport
 * replace this component and drive `selection.apply({ add, remove })`, the
 * same path the control panel uses.
 */
</script>

<div class="placeholder">
  <h2>Assistant</h2>
  <p>
    Soon you will describe your business here and an on-device model will pick
    the packages for you. For now, choose packages on the
    <a href={appHref('/')}>Planner</a> page.
  </p>
</div>

<style>
  .placeholder {
    display: grid;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-4);
  }

  h2,
  p {
    margin: 0;
  }

  p {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
