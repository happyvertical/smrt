<script lang="ts">
import { cookbookStore } from '$lib/cookbook/store.svelte.ts';
import type { AppSettings as Settings } from '$lib/settings/app-settings.ts';
import AppSettings from './AppSettings.svelte';
import ThemeSection from './ThemeSection.svelte';

// The editor holds its own copy so typing is never fought by the store;
// changes reach the cookbook after a short pause (and its save follows).
const DELAY_MS = 300;
let draft = $state<Settings>(cookbookStore.settings());
let timer: ReturnType<typeof setTimeout> | undefined;

function change(next: Settings) {
  draft = next;
  clearTimeout(timer);
  timer = setTimeout(commit, DELAY_MS);
}

function commit() {
  clearTimeout(timer);
  timer = undefined;
  cookbookStore.setSettings(draft);
}

// A cookbook, import or reset replaces the cookbook: show what it holds.
$effect(() => {
  const stored = cookbookStore.settings();
  if (timer === undefined) draft = stored;
});
</script>

<div class="pane">
  <p class="meta">
    Defaults for this app. They apply to new records only; existing records
    keep their values.
  </p>
  <AppSettings value={draft} onchange={change} idPrefix="app-settings-tab" />
  <ThemeSection />
</div>

<svelte:window onpagehide={commit} />

<style>
  .pane {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  .meta {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }
</style>
